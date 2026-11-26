// Mounted in the engine's runtime tests by run.mjs.
package runtime

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cicord/cicord/internal/auth"
	"github.com/cicord/cicord/internal/discord"
	"github.com/cicord/cicord/internal/plugin"
	"github.com/cicord/cicord/internal/sim"
	"github.com/cicord/cicord/internal/source"
	"github.com/cicord/cicord/internal/state"
	"github.com/cicord/cicord/internal/state/sqlite"
)

// Keep the simulated Discord guild alive while restarting the entire runtime
// and restoring the pre-erasure SQLite file. The HMAC erasure marker survives
// outside the backup, just as it does in production.
func TestRegistryBanEraseAndRestore(t *testing.T) {
	ctx := t.Context()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	world := sim.NewWorld()
	owner, target := world.CreateUser("owner"), world.CreateUser("private-target")
	guild := world.CreateServer("Community", owner.ID)
	token, bot, app := world.CreateBot("Moderator")
	_, err := world.AddBotToServer(guild.ID, bot.ID, discord.MustPermissions("Administrator"))
	must(err)
	must(world.AddMember(guild.ID, target.ID))
	dir := t.TempDir()
	copyTree(t, "../../examples/basic", dir)
	replaceIn(t, filepath.Join(dir, "servers/my-community.yaml"), `discordId: "112233445566778899"`, `discordId: "`+guild.ID+`"`)
	botFile := filepath.Join(dir, "bots/moderator/bot.yaml")
	replaceIn(t, botFile, `applicationId: "998877665544332211"`, `applicationId: "`+app+`"`)
	const grants = "[discord.auditlog.read,discord.channels.read,discord.members.moderate,discord.messages.manage,discord.messages.read,discord.messages.send,events.publish,portal.routes,scheduler,storage.kv]"
	replaceIn(t, botFile, "    - name: onboarding", "    - name: moderation\n      source: ../../plugins/moderation\n      grants: "+grants+"\n      config: {logChannel: general}\n    - name: onboarding")
	probe := filepath.Join(dir, "plugins/moderation")
	must(os.Mkdir(probe, 0700))
	for _, file := range []string{"bans.ts", "moderation.ts"} {
		b, err := os.ReadFile(filepath.Join(os.Getenv("CICORD_MODERATION_SRC"), file))
		must(err)
		must(os.WriteFile(filepath.Join(probe, file), b, 0600))
	}
	must(os.WriteFile(filepath.Join(probe, "plugin.yaml"), []byte("apiVersion: cicord.dev/v1alpha1\nkind: Plugin\nmetadata: {name: moderation, version: 0.2.0}\nspec:\n  engine: '>=0.1.0'\n  entry: ./index.ts\n  intents: [ServerModeration]\n  capabilities: "+grants+"\n  delivery: at-least-once\n  config: {schema: ./config.json}\n  privacy:\n    records: [{name: bans, policy: anonymize, description: Preserves a temporary sanction until release}]\n"), 0600))
	must(os.WriteFile(filepath.Join(probe, "config.json"), []byte(`{"type":"object","properties":{"logChannel":{"type":"string"}}}`), 0600))
	must(os.WriteFile(filepath.Join(probe, "index.ts"), []byte(`import {definePlugin} from "@cicord/sdk";
import {applyBan,expireBan,bindBanEvidence,preserveBanTasksForErasure} from "./bans.ts";
import {deliverCase,expireCaseLog,redactCaseDelivery} from "./moderation.ts";
export default definePlugin({tasks:{expireBan,bindBanEvidence,deliverCase,expireCaseLog},
 routes:{"POST /ban":{access:"admin",async handler(ctx,r){await applyBan(ctx,{id:r.body.id,name:"private-target"},null,"private-reason",false,1);return {ok:true}}}},
 privacy:{async export(){return {}},async erase(ctx,id){await preserveBanTasksForErasure(ctx,id,await ctx.privacy.pseudonym(id));await redactCaseDelivery(ctx,1);return {erased:1}}}});`), 0600))
	db := filepath.Join(t.TempDir(), "state.db")
	rev := source.Revision{ID: "fixture", SHA: "fixture", Dir: dir}
	opts := Options{Mode: "dev", Simulator: true, Connector: world, Signer: auth.NewSigner(auth.RandomKey()), PrivacyDir: t.TempDir(), PortalURL: "http://localhost", Secrets: func(name string) (string, bool) { return token, name == "DISCORD_TOKEN_MODERATOR" }}
	var rt *Runtime
	start := func() {
		s, err := sqlite.Open(db)
		must(err)
		opts.Store = s
		rt = New(opts)
		must(rt.Activate(ctx, rev, true))
	}
	stop := func() {
		if rt != nil {
			rt.shutdown()
			must(rt.Store().Close())
			rt = nil
		}
	}
	defer stop()
	start()
	const server, scope = "my-community", "plugin:moderator/moderation/my-community"
	input, _ := json.Marshal(map[string]string{"id": target.ID})
	_, _, err = rt.HandleRoute(ctx, server, "moderator", "moderation", "POST", "/ban", plugin.RouteRequest{Body: input})
	must(err)
	ledger := func() map[string]json.RawMessage {
		raw, err := rt.Store().KV(scope).Get(ctx, "ban-expiry:1")
		must(err)
		var m map[string]json.RawMessage
		must(json.Unmarshal(raw, &m))
		return m
	}
	row := ledger()
	if len(row["proof"]) == 0 {
		t.Fatal("simulator failed to bind the ban audit entry")
	}
	var old string
	must(json.Unmarshal(row["taskId"], &old))
	must(rt.Store().Tasks().Cancel(ctx, scope, old))
	delete(row, "opaqueJobs")
	row["taskId"] = json.RawMessage(`"legacy-timer"`)
	raw, err := json.Marshal(row)
	must(err)
	must(rt.Store().KV(scope).Set(ctx, "ban-expiry:1", raw, 0))
	legacy, _ := json.Marshal(map[string]any{"number": 1, "user": target.ID})
	must(rt.Store().Tasks().Schedule(ctx, state.Task{ID: "legacy-timer", Scope: scope, Name: "expireBan", Payload: legacy, RunAt: time.Now().Add(time.Minute)}))
	stop()
	backup, err := os.ReadFile(db)
	must(err)
	start()
	rep, err := rt.MemberData(ctx, server, target.ID, "erase")
	must(err)
	for _, item := range rep.Plugins {
		if item.Instance == "moderator/moderation" && item.Status != "ok" {
			t.Fatalf("erase: %+v", item)
		}
	}
	stop()
	must(os.WriteFile(db, backup, 0600))
	start()
	row = ledger()
	if string(row["opaqueJobs"]) != "true" || len(row["erasedTarget"]) == 0 {
		t.Fatalf("backup did not reapply migration: %s", row)
	}
	due, err := rt.Store().Tasks().Due(ctx, time.Now().Add(2*time.Minute), 100)
	must(err)
	var repaired bool
	for _, task := range due {
		if task.Scope == scope && task.Name == "expireBan" {
			if task.ID == "legacy-timer" || bytes.Contains(task.Payload, []byte(target.ID)) {
				t.Fatalf("raw expiry survived: %s", task.Payload)
			}
			repaired = true
		}
	}
	if !repaired {
		t.Fatal("erasure removed the only expiry")
	}
	rt.sched.runTasks(ctx, time.Now().Add(2*time.Minute))
	until := time.Now().Add(10 * time.Second)
	for len(rt.sched.slots) != 0 && time.Now().Before(until) {
		time.Sleep(10 * time.Millisecond)
	}
	must(world.AddMember(guild.ID, target.ID))
	for _, key := range []string{"case:1", "case:2"} {
		b, err := rt.Store().KV(scope).Get(ctx, key)
		must(err)
		if strings.Contains(string(b), target.ID) || !bytes.Contains(b, []byte("deleted-user-")) {
			t.Fatalf("released case restored the erased target: %s", b)
		}
	}
	for _, key := range []string{"active-ban:" + target.ID, "ban-expiry:1", "case-log:1"} {
		if _, err := rt.Store().KV(scope).Get(ctx, key); err != state.ErrNotFound {
			t.Fatalf("retained completed enforcement state %s: %v", key, err)
		}
	}
	index, _, err := rt.Store().KV(scope).List(ctx, "case-user:"+target.ID+":", 10, "")
	must(err)
	if len(index) > 0 {
		t.Fatal("release restored a reverse index for the erased user")
	}

}
