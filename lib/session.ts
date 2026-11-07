// The signed-in session, shared by all screens.
import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "./supabase";

export function useSession(): { session: Session | null; ready: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabaseConfigured);
  useEffect(() => {
    if (!supabaseConfigured) return;
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return { session, ready };
}
