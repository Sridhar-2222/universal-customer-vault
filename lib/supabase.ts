// One Supabase client for Android and web. Only the PUBLIC project URL and anon (publishable) key are used here;
// they are safe in an app because Row Level Security decides what each signed-in person can read. Never put a
// service-role key in the app.
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";

/** False until the two public values are set (see .env.example); the app then shows setup steps instead. */
// http is accepted only for a local test server on this machine (scripts/local-api.mjs).
export const supabaseConfigured = /^(https:\/\/.+|http:\/\/(127\.0\.0\.1|localhost):\d+)$/.test(url) && key.length > 20;

export const supabase = createClient(supabaseConfigured ? url : "https://not-configured.invalid", supabaseConfigured ? key : "not-configured", {
  // The vault's own schema inside the Fingertip project (exposed to the API in Supabase settings).
  db: { schema: "customer_vault" },
  auth: {
    storage: Platform.OS === "web" ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
  },
});

export const BUCKET = "customer-vault";
