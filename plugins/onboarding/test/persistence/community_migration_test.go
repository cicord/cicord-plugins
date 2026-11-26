// Compiled inside the companion Cicord engine's plugin test package by run.mjs.
// Both plugins are loaded directly from the registry checkout.
package plugin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cicord/cicord/internal/build"
	"github.com/cicord/cicord/internal/state"
	"github.com/cicord/cicord/internal/state/postgres"
	"github.com/cicord/cicord/internal/state/sqlite"
	"github.com/jackc/pgx/v5"
)

func TestCommunityPublishedMigrations(t *testing.T) {
	for _, name := range []string{"onboarding", "voice-rooms"} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(os.Getenv("CICORD_REGISTRY_PLUGINS"), name)
			bundled, err := build.Bundle(root, "./src/index.ts")
			if err != nil {
				t.Fatal(err)
			}
			t.Run("SQLite", func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "test.db")
				testCommunityMigration(t, name, bundled.Code, func() (state.Store, error) { return sqlite.Open(path) })
			})
			t.Run("Postgres", func(t *testing.T) {
				dsn := os.Getenv("CICORD_TEST_POSTGRES_URL")
				if dsn == "" {
					t.Skip("CICORD_TEST_POSTGRES_URL requires a disposable test database")
				}
				u, err := url.Parse(dsn)
				if err != nil {
					t.Fatal("invalid test database URL")
				}
				conn, err := pgx.Connect(t.Context(), dsn)
				if err != nil {
					t.Fatal("test database unavailable")
				}
				defer conn.Close(context.Background())
				var nonce [12]byte
				if _, err = rand.Read(nonce[:]); err != nil {
					t.Fatal(err)
				}
				schema := "community_migration_" + hex.EncodeToString(nonce[:])
				ident := pgx.Identifier{schema}.Sanitize()
				if _, err = conn.Exec(t.Context(), "CREATE SCHEMA "+ident); err != nil {
					t.Fatal(err)
				}
				defer func() {
					if _, err := conn.Exec(context.Background(), "DROP SCHEMA "+ident+" CASCADE"); err != nil {
						t.Error(err)
					}
				}()
				q := u.Query()
				q.Set("search_path", schema)
				u.RawQuery = q.Encode()
				testCommunityMigration(t, name, bundled.Code, func() (state.Store, error) { return postgres.Open(t.Context(), u.String()) })
			})
		})
	}
}

func testCommunityMigration(t *testing.T, name, code string, open func() (state.Store, error)) {
	t.Helper()
	ctx := t.Context()
	scope := "plugin:community/" + name + "/test"
	store, err := open()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if store != nil {
			_ = store.Close()
		}
	}()
	var keyPrefix, handler string
	var count int
	switch name {
	case "onboarding":
		keyPrefix, handler, count = "completed:", "migrate", 83
	case "voice-rooms":
		keyPrefix, handler, count = "room:", "sweep", 59
	}
	kv := store.KV(scope)
	for i := 0; i < count; i++ {
		row := map[string]any{"at": time.Now().UTC(), "answers": map[string]any{"interests": []string{"reading"}}}
		if name == "voice-rooms" {
			row = map[string]any{"hub": "300", "owner": fmt.Sprint(2000 + i), "n": i + 1, "createdAt": time.Now().UTC()}
		}
		raw, _ := json.Marshal(row)
		if err := kv.Set(ctx, keyPrefix+fmt.Sprintf("%04d", 1000+i), raw, 0); err != nil {
			t.Fatal(err)
		}
	}
	if name == "onboarding" {
		if err := kv.Set(ctx, "completed:expired", json.RawMessage(`{"at":"2020-01-01","answers":{}}`), 0); err != nil {
			t.Fatal(err)
		}
	}
	start := func() *Instance {
		return startCode(t, code, func(e *Env) {
			e.KV = store.KV(scope)
			e.Tasks = store.Tasks()
			e.TaskScope = scope
			e.Config = map[string]any{"enabled": true, "hubs": []any{}, "steps": []any{}, "onRestart": "adopt"}
		}).inst
	}
	vm := start()
	run := func(payload json.RawMessage) {
		if err := vm.RunTask(ctx, handler, payload, TaskDelivery{ID: "migration", Attempt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	run(nil)
	if v, err := kv.Get(ctx, "meta:schema"); (err != nil && !errors.Is(err, state.ErrNotFound)) || string(v) == "2" {
		t.Fatalf("first page unexpectedly finished: %s %v", v, err)
	}
	// Simulate a process exit after the first batch without acknowledging any scheduled continuations.
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
	vm = start()
	for burst := 0; burst < 10; burst++ {
		now := time.Now().Add(time.Minute)
		claims, err := store.Tasks().ClaimDue(ctx, now, now.Add(time.Minute), "restarted", 8)
		if err != nil {
			t.Fatal(err)
		}
		if len(claims) == 0 {
			break
		}
		for _, claim := range claims {
			if claim.Name != handler {
				t.Fatalf("unexpected migration task %s", claim.Name)
			}
			run(claim.Payload)
			if err := store.Tasks().Acknowledge(ctx, claim); err != nil {
				t.Fatal(err)
			}
		}
	}
	if v, err := kv.Get(ctx, "meta:schema"); err != nil || string(v) != "2" {
		t.Fatalf("migration incomplete: %s %v", v, err)
	}
	for i := 0; i < count; i++ {
		k := keyPrefix + fmt.Sprintf("%04d", 1000+i)
		v, err := kv.Get(ctx, k)
		if err != nil {
			t.Fatal(err)
		}
		var row map[string]any
		if err = json.Unmarshal(v, &row); err != nil {
			t.Fatalf("missing %s: %v", k, err)
		}
		if name == "onboarding" && row["answers"] == nil {
			t.Fatalf("lost answers for %s", k)
		}
		if name == "voice-rooms" && (row["legacy"] != true || row["owner"] != fmt.Sprint(2000+i)) {
			t.Fatalf("bad migrated room %s: %s", k, v)
		}
	}
	if name == "onboarding" {
		if v, err := kv.Get(ctx, "completed:expired"); !errors.Is(err, state.ErrNotFound) {
			t.Fatalf("expired data retained: %s %v", v, err)
		}
	}
}
