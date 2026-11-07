import { Tabs } from "expo-router";
import { Text } from "react-native";
import { colors } from "@/components/ui";

import type { ColorValue } from "react-native";
const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ fontSize: 20, color }}>{glyph}</Text>;

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: colors.primary, headerTitleStyle: { fontWeight: "800" } }}>
      <Tabs.Screen name="index" options={{ title: "Vault", tabBarIcon: icon("🗂") }} />
      <Tabs.Screen name="accounting" options={{ title: "Accounts", tabBarIcon: icon("₹") }} />
      <Tabs.Screen name="sharing" options={{ title: "Sharing", tabBarIcon: icon("🔗") }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("⚙") }} />
    </Tabs>
  );
}
