import { useEffect, useState } from "react";
import { ScrollView } from "react-native";
import { Button, Card, H2, P, Screen } from "@/components/ui";
import { supabase } from "@/lib/supabase";

type Act = { id: number; action: string; at: string };

export default function Settings() {
  const [email, setEmail] = useState("");
  const [acts, setActs] = useState<Act[]>([]);
  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ""));
    void supabase.from("vault_activity").select("id,action,at").order("at", { ascending: false }).limit(50).then(({ data }) => setActs((data ?? []) as Act[]));
  }, []);
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Card>
          <H2>Account</H2>
          <P>{email}</P>
          <Button title="Sign out" kind="outline" onPress={() => void supabase.auth.signOut()} />
        </Card>
        <Card>
          <H2>Activity history</H2>
          <P muted>Everything that happened in your vault. Nobody can edit this list.</P>
          {acts.length === 0 ? <P muted>No activity yet.</P> : acts.map((a) => <P key={a.id}>{a.at.slice(0, 16).replace("T", " ")} · {a.action.replace(/_/g, " ")}</P>)}
        </Card>
      </ScrollView>
    </Screen>
  );
}
