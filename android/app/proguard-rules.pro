# androidx.credentials 以反射載入 Play services provider（官方文件建議的 keep 規則）。
-if class androidx.credentials.CredentialManager
-keep class androidx.credentials.playservices.** {
  *;
}
