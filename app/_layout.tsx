import { Redirect, Stack, usePathname } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSession } from "@/lib/session";
import { supabaseConfigured } from "@/lib/supabase";
import { colors } from "@/components/ui";

export { ErrorBoundary } from "expo-router";

// Private app: everything needs sign-in, except the sign-in page and the setup page.
export default function RootLayout() {
  const { session, ready } = useSession();
  const path = usePathname();
  if (!ready) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }}><ActivityIndicator /></View>;
  if (!supabaseConfigured && path !== "/setup") return <Redirect href="/setup" />;
  if (supabaseConfigured && !session && path !== "/sign-in") return <Redirect href="/sign-in" />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="setup" />
    </Stack>
  );
}
