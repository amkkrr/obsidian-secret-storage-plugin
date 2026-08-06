/**
 * RFC-001 §8 单元测试：crypto.ts（CryptoService）
 * 使用真实 WebCrypto（Node ≥ 20 全局可用），验证加解密闭环与格式兼容。
 */
import { describe, it, expect } from "vitest";
import { cryptoService } from "../src/crypto";

const PASSWORD = "test-password-123456!";

describe("CryptoService 静态常量", () => {
  it("按 OWASP 2023 推荐配置", () => {
    expect(cryptoService.constructor.ITERATIONS).toBe(31e4);
    expect(cryptoService.constructor.KEY_LENGTH).toBe(256);
    expect(cryptoService.constructor.SALT_LENGTH).toBe(16);
    expect(cryptoService.constructor.IV_LENGTH).toBe(12);
    expect(cryptoService.constructor.VERIFIER_PLAINTEXT).toContain("obsidian-secret-storage");
  });
});

describe("基础加密原语", () => {
  it("generateDeviceId 生成稳定前缀的随机 ID", () => {
    const a = cryptoService.generateDeviceId();
    const b = cryptoService.generateDeviceId();
    expect(a).toMatch(/^device-/);
    expect(a).not.toBe(b);
  });

  it("encrypt/decrypt 闭环", async () => {
    const salt = cryptoService.generateSalt();
    const key = await cryptoService.deriveKey(PASSWORD, salt);
    const { iv, ciphertext } = await cryptoService.encrypt("hello-secret", key);
    const decrypted = await cryptoService.decrypt(ciphertext, key, iv);
    expect(decrypted).toBe("hello-secret");
  });

  it("createVerifier/verifyPassword 闭环", async () => {
    const key = await cryptoService.deriveKey(PASSWORD, cryptoService.generateSalt());
    const { iv, verifier } = await cryptoService.createVerifier(key);
    expect(await cryptoService.verifyPassword(key, iv, verifier)).toBe(true);
  });

  it("verifyPassword 错误验证器返回 false", async () => {
    const key = await cryptoService.deriveKey(PASSWORD, cryptoService.generateSalt());
    const other = await cryptoService.deriveKey("other-password-123!", cryptoService.generateSalt());
    const { iv, verifier } = await cryptoService.createVerifier(other);
    expect(await cryptoService.verifyPassword(key, iv, verifier)).toBe(false);
  });
});

describe("createEncryptedVault / decryptVault", () => {
  it("创建 v2 格式并解密还原 secrets", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, { k: "v" }, "device-1");
    expect(vault.version).toBe(2);
    expect(vault.algorithm).toBe("AES-256-GCM");
    expect(vault.kdf).toBe("PBKDF2");
    expect(vault.deviceId).toBe("device-1");
    expect(vault.lastModified).toBeTruthy();
    expect(vault.salt).toBeTruthy();
    expect(vault.data).toBeTruthy();

    const data = await cryptoService.decryptVault(vault, PASSWORD);
    expect(data.secrets).toEqual({ k: "v" });
    expect(data.metadata.version).toBe(1);
  });

  it("decryptVault 密码错误返回 null", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, {}, "d");
    expect(await cryptoService.decryptVault(vault, "wrong")).toBeNull();
  });

  it("decryptVault 损坏数据返回 null", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, {}, "d");
    vault.data = "###corrupted###";
    expect(await cryptoService.decryptVault(vault, PASSWORD)).toBeNull();
  });

  it("decryptVault 缺字段返回 null", async () => {
    expect(await cryptoService.decryptVault({}, PASSWORD)).toBeNull();
  });
});

describe("updateEncryptedVault / changePassword", () => {
  it("updateEncryptedVault 保持 salt、更新 lastModified/deviceId", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, { a: "1" }, "device-A");
    const updated = await cryptoService.updateEncryptedVault(vault, PASSWORD, { a: "1", b: "2" }, "device-A");
    expect(updated.salt).toBe(vault.salt);
    expect(updated.deviceId).toBe("device-A");
    expect(updated.lastModified).not.toBe(vault.lastModified);

    const data = await cryptoService.decryptVault(updated, PASSWORD);
    expect(data.secrets).toEqual({ a: "1", b: "2" });
    // 既有行为：metadata.version = (vault.version || 1) + 1，其中 vault.version 为文件格式版本（2）
    expect(data.metadata.version).toBe(3);
  });

  it("updateEncryptedVault 密码错误返回 null", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, {}, "d");
    expect(await cryptoService.updateEncryptedVault(vault, "wrong", {}, "d")).toBeNull();
  });

  it("changePassword 用新密码可解密且 secrets 保留", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, { k: "v" }, "device-A");
    const changed = await cryptoService.changePassword(vault, PASSWORD, "new-pass-123456!", "device-A");
    expect(changed).toBeTruthy();
    const data = await cryptoService.decryptVault(changed, "new-pass-123456!");
    expect(data.secrets).toEqual({ k: "v" });
  });

  it("changePassword 旧密码错误返回 null", async () => {
    const vault = await cryptoService.createEncryptedVault(PASSWORD, {}, "d");
    expect(await cryptoService.changePassword(vault, "wrong", "new-pass-123456!", "d")).toBeNull();
  });
});

describe("base64 工具", () => {
  it("arrayBufferToBase64 / base64ToUint8Array 互逆", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
    const b64 = cryptoService.arrayBufferToBase64(bytes.buffer);
    const back = cryptoService.base64ToUint8Array(b64);
    expect([...back]).toEqual([...bytes]);
  });

  it("base64ToArrayBuffer 返回 ArrayBuffer", () => {
    const ab = cryptoService.base64ToArrayBuffer("AAEC");
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([0, 1, 2]));
  });
});
