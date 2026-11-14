export default {
  testEnvironment: "node",
  // Script tests reload the Hedera SDK for every test (to mock it); with the
  // suites running in parallel one test can pass the 5-second default.
  testTimeout: 20000,
  transform: { "^.+\\.jsx?$": "babel-jest" },
  // NETWORK is required by the scripts; the tests run as on testnet
  setupFiles: ["<rootDir>/testHelpers/setupNetwork.js"],
};
