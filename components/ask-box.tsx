import { useState } from "react";
import { Button, Card, Field, H2, P } from "@/components/ui";
import { answerQuestion, EXAMPLES, parseQuestion, type Api } from "@/lib/ask";
import { iso } from "@/lib/periods";

// Ask about your accounts in plain words. Understood on this device by fixed rules; answered from posted entries.
export function AskBox({ api }: { api: Api }) {
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function ask(text = q) {
    if (!text.trim()) return;
    setBusy(true);
    try { setLines(await answerQuestion(parseQuestion(text), api, iso(new Date()))); }
    catch { setLines(["Could not load the answer. Check the internet and try again."]); }
    setBusy(false);
  }
  return (
    <Card>
      <H2>Ask about your accounts</H2>
      <Field label="Your question" placeholder={EXAMPLES[0]} value={q} onChangeText={setQ} onSubmitEditing={() => void ask()} returnKeyType="search" />
      <Button title="Ask" onPress={() => void ask()} busy={busy} disabled={!q.trim()} />
      {lines.map((l, i) => <P key={i}>{l}</P>)}
      <P muted>Answers come only from posted entries. Nothing is sent to any AI service.</P>
    </Card>
  );
}
