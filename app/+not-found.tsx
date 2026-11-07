import { Link } from "expo-router";
import { Screen, H1, P } from "@/components/ui";
import { View } from "react-native";

export default function NotFound() {
  return (
    <Screen>
      <View style={{ padding: 16, gap: 12 }}>
        <H1>Page not found</H1>
        <Link href="/"><P>Go to your vault</P></Link>
      </View>
    </Screen>
  );
}
