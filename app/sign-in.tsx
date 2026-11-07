import { router } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";
import { Button, Card, Field, H1, P, Screen } from "@/components/ui";
import { supabase } from "@/lib/supabase";

// Email one-time code: no password to forget. Each person gets their own account and vault.
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const clean = email.trim().toLowerCase();

  async function send() {
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.signInWithOtp({ email: clean, options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) setMsg(error.status === 429 ? "Too many codes just now. Wait a few minutes." : "Could not send the code. Check the email address and internet.");
    else setSent(true);
  }
  async function verify() {
    setBusy(true); setMsg(null);
    const { error } = await supabase.auth.verifyOtp({ email: clean, token: code.replace(/\D/g, ""), type: "email" });
    setBusy(false);
    if (error) setMsg("That code is wrong or has expired. Send a new one.");
    else router.replace("/");
  }
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 480, width: "100%", alignSelf: "center" }}>
        <H1>Universal Customer Vault</H1>
        <P muted>Your bills, warranties and records in one private place.</P>
        <Card>
          {!sent ? (
            <>
              <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
              <Button title="Send code" onPress={() => void send()} busy={busy} disabled={!/^\S+@\S+\.\S{2,}$/.test(clean)} />
            </>
          ) : (
            <>
              <P>Code sent to {clean}. Look in Spam if it is not in the inbox.</P>
              <Field label="6-digit code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" maxLength={10} />
              <Button title="Sign in" onPress={() => void verify()} busy={busy} disabled={code.replace(/\D/g, "").length < 6} />
              <Button title="Use another email" kind="outline" onPress={() => { setSent(false); setCode(""); }} />
            </>
          )}
          {msg && <P danger>{msg}</P>}
        </Card>
      </ScrollView>
    </Screen>
  );
}
