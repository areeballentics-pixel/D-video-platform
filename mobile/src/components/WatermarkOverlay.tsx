// WatermarkOverlay — translucent text overlay positioned randomly every 30s
// over the player surface. Discourages screen-recording with a visible
// per-student identifier.
//
// Rendered on the JS side (RN view tree) on top of the native video surface.
// Doesn't actually prevent recording — that's FLAG_SECURE on Android and
// UIScreen.isCaptured on iOS, both handled by the native module. This is the
// "if they got around the system block, the recording itself outs them"
// layer of defense in depth.

import { useEffect, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";

interface Props {
  email: string;
  licenseKeyShort: string; // already truncated by caller
}

export default function WatermarkOverlay({ email, licenseKeyShort }: Props) {
  const { width, height } = useWindowDimensions();
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const tick = () => {
      // Keep watermark at least 100 px in from the edges so it stays visible.
      const margin = 100;
      const x = margin + Math.random() * Math.max(0, width - margin * 2);
      const y = margin + Math.random() * Math.max(0, height - margin * 2);
      setPosition({ x, y });
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [width, height]);

  return (
    <View pointerEvents="none" style={styles.container}>
      <Text
        style={[
          styles.text,
          { left: position.x, top: position.y },
        ]}
      >
        {email} · {licenseKeyShort}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  text: {
    position: "absolute",
    color: "rgba(255, 255, 255, 0.45)",
    fontSize: 14,
    fontWeight: "600",
    textShadowColor: "rgba(0, 0, 0, 0.7)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
});
