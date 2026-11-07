// Small shared building blocks: large touch targets, plain words, one colour accent.
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";

export const colors = { bg: "#F5F7FA", card: "#FFFFFF", text: "#0F1C2E", muted: "#5B6878", primary: "#0B5FFF", danger: "#C62828", line: "#D9DEE5", ok: "#1B7F3B" };

export function Screen({ children }: { children: ReactNode }) {
  return <View style={s.screen}>{children}</View>;
}
export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}
export function H1({ children }: { children: ReactNode }) {
  return <Text style={s.h1}>{children}</Text>;
}
export function H2({ children }: { children: ReactNode }) {
  return <Text style={s.h2}>{children}</Text>;
}
export function P({ children, muted, danger, ok }: { children: ReactNode; muted?: boolean; danger?: boolean; ok?: boolean }) {
  return <Text style={[s.p, muted && { color: colors.muted }, danger && { color: colors.danger }, ok && { color: colors.ok }]}>{children}</Text>;
}
export function Button({ title, onPress, kind = "primary", disabled, busy }: { title: string; onPress: () => void; kind?: "primary" | "outline" | "danger"; disabled?: boolean; busy?: boolean }) {
  const outline = kind !== "primary";
  return (
    <Pressable accessibilityRole="button" disabled={disabled || busy} onPress={onPress}
      style={({ pressed }) => [s.btn, outline && { backgroundColor: "transparent", borderWidth: 2, borderColor: kind === "danger" ? colors.danger : colors.primary }, (disabled || busy) && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
      {busy ? <ActivityIndicator color={outline ? colors.primary : "#fff"} /> : <Text style={[s.btnText, outline && { color: kind === "danger" ? colors.danger : colors.primary }]}>{title}</Text>}
    </Pressable>
  );
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} style={s.input} accessibilityLabel={label} {...props} />
    </View>
  );
}
export function Chips<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="button" accessibilityState={{ selected: value === o.value }}
          style={[s.chip, value === o.value && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
          <Text style={{ color: value === o.value ? "#fff" : colors.text, fontWeight: "600" }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 16, gap: 10, borderWidth: 1, borderColor: colors.line },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text },
  h2: { fontSize: 18, fontWeight: "700", color: colors.text },
  p: { fontSize: 15, color: colors.text, lineHeight: 21 },
  label: { fontSize: 14, fontWeight: "600", color: colors.text },
  input: { minHeight: 48, borderWidth: 2, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 12, fontSize: 16, color: colors.text, backgroundColor: "#fff" },
  btn: { minHeight: 48, borderRadius: 12, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  btnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 2, borderColor: colors.line, justifyContent: "center" },
});
