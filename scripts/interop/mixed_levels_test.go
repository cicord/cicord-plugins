// Mounted into the companion engine's internal/runtime tests by run.mjs. The
// three installations use unmodified registry sources. Only ballots are seeded;
// creation, closure, publication, XP, leases and acknowledgements use the runtime.
package runtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cicord/cicord/internal/auth"
	"github.com/cicord/cicord/internal/config"
	"github.com/cicord/cicord/internal/discord"
	"github.com/cicord/cicord/internal/plugin"
	"github.com/cicord/cicord/internal/sim"
	"github.com/cicord/cicord/internal/source"
	"github.com/cicord/cicord/internal/state"
	"github.com/cicord/cicord/internal/state/sqlite"
	"gopkg.in/yaml.v3"
)

func TestRegistryMixedLevels(t *testing.T) {
	const voters = 4000
	const bonus = 2
	ctx := t.Context()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	until := func(what string, predicate func() bool) {
		t.Helper()
		deadline := time.Now().Add(30 * time.Second)
		for !predicate() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	world := sim.NewWorld()
	owner := world.CreateUser("owner")
	guild := world.CreateServer("Mixed plugins", owner.ID)
	publisherToken, publisherBot, publisherApp := world.CreateBot("Community")
	modernToken, modernBot, modernApp := world.CreateBot("Rewards")
	for _, bot := range []discord.User{publisherBot, modernBot} {
		_, err := world.AddBotToServer(guild.ID, bot.ID, discord.MustPermissions("Administrator"))
		must(err)
	}
	repo := t.TempDir()
	write := func(name, s string) {
		t.Helper()
		path := filepath.Join(repo, name)
		must(os.MkdirAll(filepath.Dir(path), 0755))
		must(os.WriteFile(path, []byte(s), 0600))
	}
	write("cicord.yaml", "apiVersion: cicord.dev/v1alpha1\nkind: Project\nmetadata: {name: mixed}\nspec: {engine: '>=0.2.0-0'}\n")
	write("servers/space.yaml", fmt.Sprintf("apiVersion: cicord.dev/v1alpha1\nkind: Server\nmetadata: {name: space}\nspec:\n  discordId: %q\n  channels: {general: {name: general, type: text}}\n", guild.ID))
	sources := map[string]string{"polls": filepath.Join(os.Getenv("CICORD_MIXED_PLUGINS"), "polls"), "legacy": os.Getenv("CICORD_MIXED_LEGACY"), "levels": filepath.Join(os.Getenv("CICORD_MIXED_PLUGINS"), "levels")}
	grants := map[string][]string{}
	for name, path := range sources {
		dest := filepath.Join(repo, "plugins", name)
		must(os.CopyFS(dest, os.DirFS(path)))
		raw, err := os.ReadFile(filepath.Join(dest, "plugin.yaml"))
		must(err)
		var manifest config.Plugin
		must(yaml.Unmarshal(raw, &manifest))
		grants[name] = manifest.Spec.Capabilities
		if name == "legacy" && (manifest.Metadata.Version != "0.1.0" || manifest.Spec.Interop != nil || manifest.Spec.Delivery != "") {
			t.Fatal("incorrect historical subscriber")
		}
	}
	grants["levels"] = append(grants["levels"], "events.subscribe", "plugins.query:polls.voters")
	botYAML := func(name, app, secret string) string {
		return fmt.Sprintf("apiVersion: cicord.dev/v1alpha1\nkind: Bot\nmetadata: {name: %s}\nspec:\n  applicationId: %q\n  token: {secretRef: %s}\n  servers: [space]\n  plugins:\n", name, app, secret)
	}
	entry := func(name string, enabled bool) string {
		g, _ := json.Marshal(grants[name])
		cfg := "{}"
		if name != "polls" {
			cfg = fmt.Sprintf("{pollBonusXp: %d}", bonus)
		}
		if !enabled {
			cfg = "{enabled: false}"
		}
		return fmt.Sprintf("    - name: %s\n      source: ../../plugins/%s\n      grants: %s\n      config: %s\n", name, name, g, cfg)
	}
	configure := func(enabled bool) {
		write("bots/community/bot.yaml", botYAML("community", publisherApp, "PUBLISHER_TOKEN")+entry("polls", enabled)+entry("legacy", true))
		write("bots/rewards/bot.yaml", botYAML("rewards", modernApp, "REWARDS_TOKEN")+entry("levels", true))
	}
	configure(true)
	// The same SQLite file, Discord world, tokens and privacy key survive the restart.
	path := filepath.Join(t.TempDir(), "runtime.db")
	key := auth.NewSigner(auth.RandomKey())
	var db *sqlite.Store
	var rt *Runtime
	stop := func() {
		if rt != nil {
			rt.shutdown()
			rt = nil
		}
		if db != nil {
			must(db.Close())
			db = nil
		}
	}
	defer stop()
	start := func(id string) {
		t.Helper()
		var err error
		db, err = sqlite.Open(path)
		must(err)
		rt = New(Options{Store: db, Connector: world, Simulator: true, Mode: "dev", Signer: key, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Secrets: func(n string) (string, bool) {
			tokens := map[string]string{"PUBLISHER_TOKEN": publisherToken, "REWARDS_TOKEN": modernToken}
			token, ok := tokens[n]
			return token, ok
		}})
		must(rt.Activate(ctx, source.Revision{ID: id, SHA: id, Dir: repo}, false))
		for _, info := range rt.Instances("space") {
			if info.Health != HealthHealthy && info.Health != HealthDisabled {
				t.Fatalf("%s: %s %s", info.Config.ID(), info.Health, info.Message)
			}
		}
	}
	start("initial")
	channel, ok := world.ChannelByName(guild.ID, "general")
	if !ok {
		t.Fatal("missing general channel")
	}
	const pollScope = "plugin:community/polls/space"
	const oldScope = "plugin:community/legacy/space"
	const newScope = "plugin:rewards/levels/space"
	// Drain the fresh ranking migration before setting the event crash point.
	rt.sched.runTasks(ctx, time.Now().Add(time.Second))
	until("migration", func() bool {
		v, _ := db.KV(newScope).Get(ctx, "meta:schema")
		return string(v) == "2" && len(rt.sched.slots) == 0
	})
	world.InvokeCommand(owner.ID, guild.ID, channel.ID, publisherApp, "poll", map[string]any{"question": "Mixed poll", "choices": "A | B"})
	until("real /poll", func() bool {
		v, _ := db.KV(pollScope).Get(ctx, "poll:1")
		return strings.Contains(string(v), `"status":"open"`)
	})
	uid := func(n int) string { return strconv.FormatInt(110000000000000000+int64(n), 10) }
	pollKV := db.KV(pollScope).(state.AdvancedKV)
	for start := 0; start < voters; start += 100 {
		var mutations []state.KVMutation
		for n := start; n < start+100; n++ {
			mutations = append(mutations, state.KVMutation{Op: "set", Key: "vote:1:" + uid(n), Value: json.RawMessage(`[0]`)})
		}
		commit, err := pollKV.Atomic(ctx, nil, mutations)
		must(err)
		if !commit.OK {
			t.Fatal("seeding ballots")
		}
	}
	world.InvokeCommand(owner.ID, guild.ID, channel.ID, publisherApp, "polls close", map[string]any{"poll": "1"})
	until("both production event versions", func() bool { v, _ := pollKV.Get(ctx, "poll:1"); return strings.Contains(string(v), `"published":true`) })
	q := db.Tasks()
	now := time.Now()
	leases, err := q.ClaimDue(ctx, now, now.Add(time.Minute), "before-restart", 10)
	must(err)
	if len(leases) != 2 {
		t.Fatalf("expected one delivery per subscriber, got %d", len(leases))
	}
	instance := func(scope string) *instanceRT {
		t.Helper()
		for _, i := range rt.Active().instances {
			if instanceScope(i.cfg) == scope {
				return i
			}
		}
		t.Fatalf("missing %s", scope)
		return nil
	}
	deliver := func(l state.TaskLease) {
		rt.sched.slots <- struct{}{}
		rt.sched.deliverTask(ctx, instance(l.Scope), l, time.Now().Add(plugin.DefaultHandlerTimeout))
	}
	var eventID string
	for _, l := range leases {
		if !l.Event || l.Name != "polls.closed" || l.Attempt != 1 || len(l.Payload) <= 64<<10 {
			t.Fatalf("bad publication: name=%s bytes=%d attempt=%d", l.Name, len(l.Payload), l.Attempt)
		}
		var envelope plugin.Event
		must(json.Unmarshal(l.Payload, &envelope))
		var result struct {
			Voters     []string
			VoterCount *int
		}
		must(json.Unmarshal(envelope.Payload, &result))
		if len(result.Voters) != voters || result.Voters[0] != uid(0) || result.Voters[voters-1] != uid(voters-1) {
			t.Fatal("incomplete ballot list")
		}
		switch l.Scope {
		case oldScope:
			if envelope.Meta.Version != 1 || result.VoterCount != nil {
				t.Fatal("legacy received wrong version")
			}
			deliver(l)
		case newScope:
			if envelope.Meta.Version != 2 || result.VoterCount == nil || *result.VoterCount != voters {
				t.Fatal("modern received wrong version")
			}
			eventID = envelope.Meta.ID
			// Run the subscribed JS handler but lose its acknowledgement. Its batch tasks
			// are already durable. The next process will receive the same event ID.
			must(checkedTask(ctx, instance(l.Scope), l, rt))
		default:
			t.Fatalf("unexpected target %s", l.Scope)
		}
	}
	if eventID == "" {
		t.Fatal("no v2 envelope")
	}
	listXP := func(scope string) map[string]int {
		t.Helper()
		seen := map[string]int{}
		cursor := ""
		for {
			items, next, err := db.KV(scope).List(ctx, "xp:", 1000, cursor)
			must(err)
			for _, row := range items {
				var n int
				must(json.Unmarshal(row.Value, &n))
				seen[strings.TrimPrefix(row.Key, "xp:")] = n
			}
			if next == "" {
				return seen
			}
			cursor = next
		}
	}
	legacy := listXP(oldScope)
	if len(legacy) == 0 {
		t.Fatal("legacy handler never ran")
	}
	for id, n := range legacy {
		if n != bonus {
			t.Fatalf("legacy double credit %s: %d", id, n)
		}
	}
	now = time.Now().Add(time.Second)
	batch, err := q.ClaimDue(ctx, now, now.Add(time.Minute), "before-restart", 1)
	must(err)
	if len(batch) != 1 || batch[0].Name != "voter-batch" || batch[0].Scope != newScope {
		t.Fatalf("first batch missing: %d", len(batch))
	}
	deliver(batch[0])
	if n := len(listXP(newScope)); n != 25 {
		t.Fatalf("committed %d XP effects before crash, expected 25", n)
	}
	stop()
	configure(false)
	start("publisher-disabled")
	_, err = rt.invokePeer(ctx, instance(newScope), "query", plugin.Request{Plugin: "polls", Name: "voters", Input: json.RawMessage(`{"pollId":"1"}`)}, plugin.CallFrame{})
	var absent *plugin.InteropError
	if !errors.As(err, &absent) || !absent.Unavailable || !strings.Contains(instance(newScope).cfg.Features["pollPages"], "not installed") {
		t.Fatal("disabled optional provider incorrectly available")
	}
	q = db.Tasks()
	now = now.Add(2 * time.Minute)
	recovered, err := q.ClaimDue(ctx, now, now.Add(time.Minute), "after-restart", 1000)
	must(err)
	replayed := 0
	for _, l := range recovered {
		if l.Scope == oldScope {
			t.Fatal("legacy delivery was replayed")
		}
		if !l.Event {
			must(q.Release(ctx, l, time.Now(), ""))
			continue
		}
		var envelope plugin.Event
		must(json.Unmarshal(l.Payload, &envelope))
		if l.Scope != newScope || l.Attempt != 2 || envelope.Meta.ID != eventID || envelope.Meta.Version != 2 {
			t.Fatal("unstable v2 retry")
		}
		deliver(l)
		replayed++
	}
	if replayed != 1 {
		t.Fatalf("replayed events %d", replayed)
	}
	// Production scheduler executes the duplicate batches. Inspect every credit,
	// rather than relying on the headline count to detect omissions and duplicates.
	for {
		rt.sched.runTasks(ctx, time.Now().Add(time.Second))
		until("scheduler workers", func() bool { return len(rt.sched.slots) == 0 })
		due, err := q.Due(ctx, time.Now().Add(time.Second), 1)
		must(err)
		if len(due) == 0 {
			break
		}
	}
	xp := listXP(newScope)
	if len(xp) != voters {
		t.Fatalf("credited %d of %d voters", len(xp), voters)
	}
	for n := 0; n < voters; n++ {
		if xp[uid(n)] != bonus {
			t.Fatalf("voter %d got %d XP", n, xp[uid(n)])
		}
	}
	after := listXP(oldScope)
	if len(after) != len(legacy) {
		t.Fatal("legacy credits changed after restart")
	}
	for id, n := range after {
		if legacy[id] != n {
			t.Fatalf("late legacy credit %s", id)
		}
	}
	dead, err := q.DeadLetters(ctx, "space", 10)
	must(err)
	if len(dead) != 0 {
		t.Fatalf("%d dead letters: %s", len(dead), dead[0].Name)
	}
	t.Logf("%d persisted ballots; %d legacy accounts credited at most once; %d v2 accounts credited exactly once; 25 v2 effects pre-restart", voters, len(legacy), len(xp))
}
