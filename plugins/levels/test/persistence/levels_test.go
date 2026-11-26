// Mounted into the companion engine's internal/plugin test package by run.mjs.
// The VM loads the production TypeScript helpers and uses the real backend APIs.
package plugin

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/cicord/cicord/internal/state"
	"github.com/cicord/cicord/internal/state/postgres"
	"github.com/cicord/cicord/internal/state/sqlite"
	"github.com/jackc/pgx/v5"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestLevelsPublishedMigration(t *testing.T) {
	module := filepath.Join(os.Getenv("CICORD_LEVELS_PLUGIN"), "src", "storage.ts")
	code := bundleSource(t, fmt.Sprintf(`
    import {definePlugin} from "@cicord/sdk";
    import {migrate,credit} from %q;
    export default definePlugin({tasks:{"migrate-ranking":migrate,async earn(ctx){await credit(ctx,"1",10,"live");await credit(ctx,"999",20,"live");}}});`, module))
	t.Run("SQLite", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "levels.db")
		levelsBackend(t, code, func() (state.Store, error) { return sqlite.Open(path) })
	})
	t.Run("Postgres", func(t *testing.T) {
		dsn := os.Getenv("CICORD_TEST_POSTGRES_URL")
		if dsn == "" {
			t.Skip("set CICORD_TEST_POSTGRES_URL to an isolated test database")
		}
		u, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid test database URL")
		}
		random := make([]byte, 12)
		if _, err = rand.Read(random); err != nil {
			t.Fatal(err)
		}
		name := "levels_test_" + hex.EncodeToString(random)
		ident := pgx.Identifier{name}.Sanitize()
		conn, err := pgx.Connect(t.Context(), dsn)
		if err != nil {
			t.Fatal("cannot connect to test database")
		}
		defer conn.Close(context.Background())
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
		levelsBackend(t, code, func() (state.Store, error) { return postgres.Open(t.Context(), u.String()) })
	})
}
func levelsBackend(t *testing.T, code string, open func() (state.Store, error)) {
	t.Helper()
	ctx := t.Context()
	const scope = "plugin:community/levels/test"
	store, err := open()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if store != nil {
			_ = store.Close()
		}
	}()
	kv := store.KV(scope)
	for i := 1; i <= 2001; i++ {
		if err := kv.Set(ctx, "xp:"+strconv.Itoa(i), json.RawMessage("17"), 0); err != nil {
			t.Fatal(err)
		}
	}
	startVM := func() *Instance {
		h := startCode(t, code, func(e *Env) {
			e.KV = store.KV(scope)
			e.Tasks = store.Tasks()
			e.TaskScope = scope
			e.Config = map[string]any{"enabled": true}
		})
		return h.inst
	}
	vm := startVM()
	task := func(name string) {
		t.Helper()
		if err := vm.RunTask(ctx, name, nil, TaskDelivery{ID: name, Attempt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	task("migrate-ranking")
	if c, err := kv.Get(ctx, "meta:cursor"); err != nil || len(c) == 0 {
		t.Fatalf("missing first batch cursor: %q %v", c, err)
	}
	if err = vm.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = open()
	if err != nil {
		t.Fatal(err)
	}
	kv = store.KV(scope)
	vm = startVM()
	task("earn")
	task("migrate-ranking")
	task("migrate-ranking")
	task("migrate-ranking")
	if v, err := kv.Get(ctx, "meta:schema"); err != nil || string(v) != "2" {
		t.Fatalf("migration incomplete: %q %v", v, err)
	}
	board := kv.(state.AdvancedKV)
	var members []state.RankedMember
	for offset := 0; offset < 2001; offset += 1000 {
		r, err := board.Rank(ctx, state.RankOp{Method: "top", Name: "xp", Limit: 1000, Offset: offset})
		if err != nil {
			t.Fatal(err)
		}
		members = append(members, r.([]state.RankedMember)...)
	}
	if len(members) != 2001 || members[0].Member != "999" || members[1].Member != "1" {
		t.Fatalf("invalid migrated leaderboard of %d entries", len(members))
	}
	for i, m := range members {
		v, err := kv.Get(ctx, "xp:"+m.Member)
		if err != nil {
			t.Fatal(err)
		}
		if string(v) != strconv.Itoa(int(m.Score)) || m.Rank != i+1 {
			t.Fatalf("inconsistent ranking: %+v vs %s", m, v)
		}
		if i > 0 && members[i-1].Score == m.Score && members[i-1].Member >= m.Member {
			t.Fatal("unstable tie order")
		}
	}
}
