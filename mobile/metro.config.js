const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

// React Native 0.76+ uses Metro for bundling. Default config is enough for
// our app — we don't bundle anything exotic.
const config = {};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
