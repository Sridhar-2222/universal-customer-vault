import { Stack } from "expo-router";
import { colors } from "@/components/ui";

export default function BusinessLayout() {
  return (
    <Stack screenOptions={{ headerShown: true, headerTintColor: colors.primary, headerTitleStyle: { fontWeight: "800", color: colors.text } }}>
      <Stack.Screen name="[id]" options={{ title: "Business" }} />
      <Stack.Screen name="invoice" options={{ title: "Invoice" }} />
      <Stack.Screen name="scan" options={{ title: "Read a bill photo" }} />
      <Stack.Screen name="register" options={{ title: "Register" }} />
      <Stack.Screen name="reports" options={{ title: "Reports" }} />
    </Stack>
  );
}
