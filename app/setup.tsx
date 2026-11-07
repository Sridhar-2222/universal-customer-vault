import { ScrollView } from "react-native";
import { Card, H1, H2, P, Screen } from "@/components/ui";

// Shown until the app is connected to a Supabase project (no secrets: only the public URL and anon key).
export default function Setup() {
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <H1>Connect the vault</H1>
        <Card>
          <H2>One-time setup</H2>
          <P>1. Create a free Supabase project and run the two files in supabase/migrations in its SQL editor.</P>
          <P>2. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (Supabase → Project settings → API).</P>
          <P>3. Rebuild the app. The README has the browser-only steps.</P>
          <P muted>Never use the service-role key in the app.</P>
        </Card>
      </ScrollView>
    </Screen>
  );
}
