// Mounted into the companion engine's internal/plugin package by run.mjs.
package plugin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/cicord/cicord/internal/state"
	"github.com/cicord/cicord/internal/state/postgres"
	"github.com/cicord/cicord/internal/state/sqlite"
	"github.com/jackc/pgx/v5"
)

func TestAuditLogPublishedMigration(t *testing.T) {
	module := filepath.Join(os.Getenv("CICORD_AUDIT_PLUGIN"), "src/log.ts")
	code := bundleSource(t, fmt.Sprintf(`import {definePlugin} from "@cicord/sdk";import {migrate} from %q;export default definePlugin({tasks:{migrate}});`, module))
	run := func(t *testing.T, open func() (state.Store, error)) {
		ctx := t.Context()
		store, err := open()
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = store.Close() }()
		scope := "plugin:bot/audit-log/acceptance"
		kv := store.KV(scope)
		for i := range 80 {
			if err := kv.Set(ctx, fmt.Sprintf("q:%012d", i), json.RawMessage(`{"text":"obsolete line","group":"members","at":3}`), 0); err != nil {
				t.Fatal(err)
			}
		}
		if err := kv.Set(ctx, "unrelated", json.RawMessage("true"), 0); err != nil {
			t.Fatal(err)
		}
		startVM := func() *Instance {
			return startCode(t, code, func(e *Env) { e.KV = store.KV(scope); e.Tasks = store.Tasks(); e.TaskScope = scope }).inst
		}
		vm := startVM()
		batch := func() {
			if err := vm.RunTask(ctx, "migrate", nil, TaskDelivery{ID: "migrate", Attempt: 1}); err != nil {
				t.Fatal(err)
			}
		}
		batch()
		if _, err := kv.Get(ctx, "migration:cursor"); err != nil {
			t.Fatal(err)
		}
		if err := vm.Stop(ctx); err != nil {
			t.Fatal(err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
		store, err = open()
		if err != nil {
			t.Fatal(err)
		}
		kv = store.KV(scope)
		vm = startVM()
		batch()
		batch()
		batch()
		items, _, err := kv.List(ctx, "q:", 100, "")
		if err != nil || len(items) != 0 {
			t.Fatal(items, err)
		}
		for key, value := range map[string]string{"meta:schema": "2", "unrelated": "true"} {
			raw, err := kv.Get(ctx, key)
			if err != nil || string(raw) != value {
				t.Fatal(key, string(raw), err)
			}
		}
	}
	t.Run("SQLite", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "audit.db")
		run(t, func() (state.Store, error) { return sqlite.Open(path) })
	})
	t.Run("Postgres", func(t *testing.T) {
		dsn := os.Getenv("CICORD_TEST_POSTGRES_URL")
		if dsn == "" {
			t.Skip("set CICORD_TEST_POSTGRES_URL to run PostgreSQL conformance")
		}
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid test database URL")
		}
		var suffix [12]byte
		rand.Read(suffix[:])
		name := "audit_log_test_" + hex.EncodeToString(suffix[:])
		ident := pgx.Identifier{name}.Sanitize()
		conn, err := pgx.Connect(t.Context(), dsn)
		if err != nil {
			t.Fatal("connect to test database")
		}
		defer conn.Close(context.Background())
		if _, err := conn.Exec(t.Context(), "CREATE SCHEMA "+ident); err != nil {
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
		run(t, func() (state.Store, error) { return postgres.Open(t.Context(), u.String()) })
	})
}
