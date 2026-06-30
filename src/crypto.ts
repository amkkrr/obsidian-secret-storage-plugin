export class CryptoService {
  /**
   * 生成随机盐值
   */
  generateSalt() {
    return crypto.getRandomValues(new Uint8Array(CryptoService.SALT_LENGTH));
  }
  /**
   * 生成随机 IV
   */
  generateIV() {
    return crypto.getRandomValues(new Uint8Array(CryptoService.IV_LENGTH));
  }
  /**
   * 生成设备 ID
   */
  generateDeviceId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return "device-" + this.arrayBufferToBase64(bytes.buffer).replace(/[+/=]/g, "").slice(0, 12);
  }
  /**
   * 从密码派生加密密钥
   * @param password 用户主密码
   * @param salt 盐值
   * @returns CryptoKey 对象
   */
  async deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: CryptoService.ITERATIONS,
        hash: "SHA-256"
      },
      keyMaterial,
      { name: "AES-GCM", length: CryptoService.KEY_LENGTH },
      false,
      // 不可导出
      ["encrypt", "decrypt"]
    );
  }
  /**
   * 加密数据
   * @param data 要加密的字符串
   * @param key 加密密钥
   * @returns IV 和密文
   */
  async encrypt(data, key) {
    const iv = this.generateIV();
    const encoder = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(data)
    );
    return { iv, ciphertext };
  }
  /**
   * 解密数据
   * @param ciphertext 密文
   * @param key 解密密钥
   * @param iv 初始化向量
   * @returns 解密后的字符串
   */
  async decrypt(ciphertext, key, iv) {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  }
  /**
   * 创建密码验证器
   * 用于快速验证密码是否正确，而不需要解密整个数据
   */
  async createVerifier(key) {
    const iv = this.generateIV();
    const encoder = new TextEncoder();
    const verifier = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(CryptoService.VERIFIER_PLAINTEXT)
    );
    return { iv, verifier };
  }
  /**
   * 验证密码是否正确
   */
  async verifyPassword(key, iv, verifier) {
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        verifier
      );
      const text = new TextDecoder().decode(decrypted);
      return text === CryptoService.VERIFIER_PLAINTEXT;
    } catch (e) {
      return false;
    }
  }
  /**
   * 创建加密的密钥库
   */
  async createEncryptedVault(password, secrets, deviceId) {
    const salt = this.generateSalt();
    const key = await this.deriveKey(password, salt);
    const { iv: verifierIv, verifier } = await this.createVerifier(key);
    const secretsData = {
      secrets,
      metadata: {
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        version: 1
      }
    };
    const { iv, ciphertext } = await this.encrypt(JSON.stringify(secretsData), key);
    return {
      version: 2,
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2",
      kdfIterations: CryptoService.ITERATIONS,
      salt: this.arrayBufferToBase64(salt.buffer),
      iv: this.arrayBufferToBase64(iv.buffer),
      verifier: this.arrayBufferToBase64(verifierIv.buffer) + ":" + this.arrayBufferToBase64(verifier),
      data: this.arrayBufferToBase64(ciphertext),
      lastModified: new Date().toISOString(),
      deviceId
    };
  }
  /**
   * 解密密钥库
   */
  async decryptVault(vault, password) {
    try {
      const salt = this.base64ToUint8Array(vault.salt);
      const key = await this.deriveKey(password, salt);
      const [verifierIvBase64, verifierBase64] = vault.verifier.split(":");
      const verifierIv = this.base64ToUint8Array(verifierIvBase64);
      const verifier = this.base64ToArrayBuffer(verifierBase64);
      const isValid = await this.verifyPassword(key, verifierIv, verifier);
      if (!isValid) {
        return null;
      }
      const iv = this.base64ToUint8Array(vault.iv);
      const ciphertext = this.base64ToArrayBuffer(vault.data);
      const decrypted = await this.decrypt(ciphertext, key, iv);
      return JSON.parse(decrypted);
    } catch (error) {
      console.error("Vault decryption failed:", error);
      return null;
    }
  }
  /**
   * 更新加密的密钥库（保持相同的 salt，重新加密）
   */
  async updateEncryptedVault(vault, password, secrets, deviceId) {
    try {
      const salt = this.base64ToUint8Array(vault.salt);
      const key = await this.deriveKey(password, salt);
      const [verifierIvBase64, verifierBase64] = vault.verifier.split(":");
      const verifierIv = this.base64ToUint8Array(verifierIvBase64);
      const verifierData = this.base64ToArrayBuffer(verifierBase64);
      const isValid = await this.verifyPassword(key, verifierIv, verifierData);
      if (!isValid) {
        return null;
      }
      const secretsData = {
        secrets,
        metadata: {
          createdAt: vault.lastModified,
          // 保持原创建时间
          modifiedAt: new Date().toISOString(),
          version: (vault.version || 1) + 1
        }
      };
      const { iv, ciphertext } = await this.encrypt(JSON.stringify(secretsData), key);
      return {
        ...vault,
        iv: this.arrayBufferToBase64(iv.buffer),
        data: this.arrayBufferToBase64(ciphertext),
        lastModified: new Date().toISOString(),
        deviceId
      };
    } catch (error) {
      console.error("Vault update failed:", error);
      return null;
    }
  }
  /**
   * 修改主密码
   */
  async changePassword(vault, oldPassword, newPassword, deviceId) {
    const secretsData = await this.decryptVault(vault, oldPassword);
    if (!secretsData) {
      return null;
    }
    return this.createEncryptedVault(newPassword, secretsData.secrets, deviceId);
  }
  // ============================================
  // 工具方法
  // ============================================
  /**
   * ArrayBuffer 转 Base64
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  /**
   * Base64 转 Uint8Array
   */
  base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  /**
   * Base64 转 ArrayBuffer
   */
  base64ToArrayBuffer(base64) {
    return this.base64ToUint8Array(base64).buffer;
  }
};
// OWASP 2023 推荐的 PBKDF2 迭代次数
CryptoService.ITERATIONS = 31e4;
CryptoService.KEY_LENGTH = 256;
CryptoService.SALT_LENGTH = 16;
// 128 bits
CryptoService.IV_LENGTH = 12;
// 96 bits (GCM 推荐)
CryptoService.VERIFIER_PLAINTEXT = "obsidian-secret-storage-v2";
export const cryptoService = new CryptoService();

