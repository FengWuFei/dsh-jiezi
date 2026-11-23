import { Text, View, colorScheme, mount, signal } from "nsh";
import { Button } from "nsh/base";

function App() {
  const count = signal(0);
  const dark = colorScheme() === "dark";
  return (
    <View
      testID="screen-counter"
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        gap: 20,
        paddingHorizontal: 24,
        // Safe areas are part of the screen, not the Host chrome.
        paddingTop: "calc(env(safe-area-inset-top) + 24px)",
        paddingBottom: "calc(env(safe-area-inset-bottom) + 24px)",
        backgroundColor: dark ? "#000000" : "#f2f2f7",
      }}
    >
      <Text testID="counter-title" style={{ fontSize: 28, fontWeight: "600", color: dark ? "#ffffff" : "#1c1c1e" }}>
        JieZi Mini App
      </Text>
      <Text testID="counter-value" style={{ fontSize: 48, fontVariant: "tabular-nums", color: dark ? "#ffffff" : "#1c1c1e" }}>
        {count()}
      </Text>
      <Button
        testID="counter-increment"
        accessibilityLabel="Increment"
        onPress={() => count.update((value) => value + 1)}
        style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12, backgroundColor: "#5856d6" }}
      >
        <Text style={{ color: "#ffffff", fontSize: 17, fontWeight: "600" }}>Increment</Text>
      </Button>
    </View>
  );
}

mount(App);
