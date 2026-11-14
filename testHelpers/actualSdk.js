import { jest } from "@jest/globals";

// The real Hedera SDK, loaded once per test file (umina-achala-chain#34).
// Script tests call jest.resetModules() before each test to mock the SDK
// again; with jest.requireActual inside the mock that also loaded the whole
// real SDK again, a few hundred ms per test. The mocks spread this one copy.
let actual;

export function actualSdk() {
  actual ??= jest.requireActual("@hashgraph/sdk");
  return actual;
}
