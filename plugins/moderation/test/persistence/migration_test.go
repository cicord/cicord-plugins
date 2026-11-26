// Mounted into Cicord's plugin test package. Run the registry entry point
// against a real on-disk store and replace the VM between task deliveries.
package plugin

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/cicord/cicord/internal/build"
	"github.com/cicord/cicord/internal/state"
	"github.com/cicord/cicord/internal/state/postgres"
	"github.com/cicord/cicord/internal/state/sqlite"
	"github.com/jackc/pgx/v5"
)

func TestRegistryModerationCaseMigration(t *testing.T) {
	pluginDir := filepath.Dir(os.Getenv("CICORD_MODERATION_SRC"))
	bundle, err := build.Bundle(pluginDir, "./src/index.ts")
	if err != nil {
		t.Fatal(err)
	}
	t.Run("SQLite", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "legacy.db")
		testRegistryMigration(t, bundle.Code, func() (state.Store, error) { return sqlite.Open(path) })
	})
	t.Run("Postgres", func(t *testing.T) {
		dsn := os.Getenv("CICORD_TEST_POSTGRES_URL")
		if dsn == "" {
			t.Skip("disposable CICORD_TEST_POSTGRES_URL not configured")
		}
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid test database URL")
		}
		conn, err := pgx.Connect(t.Context(), dsn)
		if err != nil {
			t.Fatal("cannot connect to the disposable test database")
		}
		defer func() { _ = conn.Close(context.Background()) }()
		var nonce [12]byte
		if _, err = rand.Read(nonce[:]); err != nil {
			t.Fatal(err)
		}
		name := "moderation_migration_" + hex.EncodeToString(nonce[:])
		ident := pgx.Identifier{name}.Sanitize()
		if _, err = conn.Exec(t.Context(), "CREATE SCHEMA "+ident); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if _, err := conn.Exec(context.Background(), "DROP SCHEMA "+ident+" CASCADE"); err != nil {
				t.Error(err)
			}
		}()
		q := u.Query()
		q.Set("search_path", name)
		u.RawQuery = q.Encode()
		testRegistryMigration(t, bundle.Code, func() (state.Store, error) { return postgres.Open(t.Context(), u.String()) })
	})
}

func testRegistryMigration(t *testing.T, code string, open func() (state.Store, error)) {
	t.Helper()
	ctx := t.Context()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	const scope = "plugin:staff/moderation/legacy"
	store, err := open()
	must(err)
	defer func() { _ = store.Close() }()
	kv := store.KV(scope)
	// 58 live pre-0.3 warnings plus one outside the one-year retention policy.
	const count = 58
	for n := 1; n <= count+1; n++ {
		at := time.Now().UTC().Add(-24 * time.Hour)
		if n > count {
			at = at.AddDate(-2, 0, 0)
		}
		row, err := json.Marshal(map[string]any{"number": n, "action": "warn", "at": at.Format(time.RFC3339Nano), "member": map[string]string{"id": "200", "name": "member"}, "moderator": map[string]string{"id": "300", "name": "moderator"}, "reason": "legacy"})
		must(err)
		must(kv.Set(ctx, "case:"+strconv.Itoa(n), row, 0))
	}
	start := func() *Instance {
		return startCode(t, code, func(e *Env) {
			e.KV = store.KV(scope)
			e.Tasks = store.Tasks()
			e.TaskScope = scope
			e.Config = map[string]any{"flood": map[string]any{"enabled": true}}
		}).inst
	}
	vm := start()
	prefix := "case-user:200:"
	indexed := func() int { t.Helper(); items, _, err := kv.List(ctx, prefix, 100, ""); must(err); return len(items) }
	if n := indexed(); n != 0 {
		t.Fatalf("onStart processed %d cases inline", n)
	}
	firstNow := time.Now().Add(time.Second)
	jobs, err := store.Tasks().ClaimDue(ctx, firstNow, firstNow.Add(time.Second), "first", 1)
	must(err)
	if len(jobs) != 1 || jobs[0].Name != "migrateCases" {
		t.Fatalf("startup wakeup %+v", jobs)
	}
	first := jobs[0]
	must(vm.RunTask(ctx, first.Name, first.Payload, TaskDelivery{ID: first.ID, Attempt: first.Attempt}))
	if n := indexed(); n != 25 {
		t.Fatalf("first page indexed %d", n)
	}
	cursor, err := kv.Get(ctx, "meta:cases-cursor")
	must(err)
	if len(cursor) == 0 {
		t.Fatal("missing persistent migration cursor")
	}
	// A moderation edit after the first chunk must survive both restart and retry.
	raw, err := kv.Get(ctx, "case:1")
	must(err)
	var edited map[string]any
	must(json.Unmarshal(raw, &edited))
	edited["reason"] = "reviewed"
	edited["status"] = "void"
	raw, err = json.Marshal(edited)
	must(err)
	must(kv.Set(ctx, "case:1", raw, 24*time.Hour))
	// Lose the first acknowledgement and restart with the same database.
	must(vm.Stop(ctx))
	must(store.Close())
	store, err = open()
	must(err)
	kv = store.KV(scope)
	vm = start()
	if n := indexed(); n != 25 {
		t.Fatalf("restart processed %d rows before a task", n)
	}
	seenRetry := false
	for round := 0; round < 10; round++ {
		now := time.Now().Add(time.Minute + time.Duration(round)*time.Second)
		due, err := store.Tasks().ClaimDue(ctx, now, now.Add(time.Second), "restart", 10)
		must(err)
		if len(due) == 0 {
			break
		}
		for _, lease := range due {
			if lease.Name != "migrateCases" {
				t.Fatalf("unexpected task %q", lease.Name)
			}
			if lease.ID == first.ID {
				seenRetry = lease.Attempt > 1
			}
			must(vm.RunTask(ctx, lease.Name, lease.Payload, TaskDelivery{ID: lease.ID, Attempt: lease.Attempt}))
			must(store.Tasks().Acknowledge(ctx, lease))
		}
	}
	schema, err := kv.Get(ctx, "meta:schema")
	must(err)
	if string(schema) != "3" || indexed() != count || !seenRetry {
		t.Fatalf("schema=%s, indexed=%d, replay=%v", schema, indexed(), seenRetry)
	}
	for _, key := range []string{"meta:cases-cursor", fmt.Sprintf("case:%d", count+1)} {
		if _, err = kv.Get(ctx, key); !errors.Is(err, state.ErrNotFound) {
			t.Fatalf("unexpected retained key %s: %v", key, err)
		}
	}
	totals, err := kv.Get(ctx, "moderator-total:300")
	must(err)
	if string(totals) != strconv.Itoa(count) {
		t.Fatalf("replay changed staff counter: %s", totals)
	}
	result, err := kv.Get(ctx, "case:1")
	must(err)
	if !bytes.Equal(result, raw) {
		t.Fatalf("migration replaced a staff edit: %s", result)
	}
	must(vm.Stop(ctx))
	vm = start()
	defer func() { _ = vm.Stop(ctx) }()
	due, err := store.Tasks().Due(ctx, time.Now().Add(time.Hour), 10)
	must(err)
	if len(due) != 0 {
		t.Fatalf("completed migration re-enqueued work: %+v", due)
	}
}
