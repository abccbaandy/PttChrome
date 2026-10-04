plugins {
    alias(libs.plugins.android.application) apply false
    // AGP 9 內建 Kotlin 綁的 KGP 太舊（2.2），讀不了新版 Google 函式庫（googleid 以 Kotlin 2.4 編譯）。
    // 只把較新的 KGP 放上 classpath（apply false），編譯仍走 AGP 內建 Kotlin。
    alias(libs.plugins.kotlin.android) apply false
}
