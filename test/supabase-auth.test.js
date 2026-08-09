import test from "node:test";
import assert from "node:assert/strict";
import { translateSupabaseAuthError } from "../src/auth/supabase-auth.js";

test("Supabase認証エラーを日本語で案内する", () => {
  assert.match(
    translateSupabaseAuthError({ code: "email_not_confirmed", message: "Email not confirmed" }),
    /未確認/,
  );
  assert.match(
    translateSupabaseAuthError({ code: "invalid_credentials", message: "Invalid login credentials" }),
    /正しくありません/,
  );
  assert.match(
    translateSupabaseAuthError({ message: "User already registered" }),
    /すでに登録/,
  );
  assert.match(
    translateSupabaseAuthError({ message: "Failed to fetch" }),
    /接続/,
  );
});
