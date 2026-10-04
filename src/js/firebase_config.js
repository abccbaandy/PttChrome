// Firebase web app config for preference cloud sync (see pref_sync.js).
// Not a secret: web configs are public by design; access control is enforced
// by Firestore security rules (firestore.rules) and Auth authorized domains.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDWg6lhCcMh3AIjSOQqnR4DIOkjltefmis",
  authDomain: "pttchrome-prefs-7k3m.firebaseapp.com",
  projectId: "pttchrome-prefs-7k3m",
  storageBucket: "pttchrome-prefs-7k3m.firebasestorage.app",
  messagingSenderId: "220067863446",
  appId: "1:220067863446:web:d166ab193e2826f5581bb7"
};

// OAuth client of the Firebase Google sign-in provider (the auto-created *Web*
// client). The Android APK hands it to Credential Manager as serverClientId so
// the returned ID token is addressed to it — Firebase only accepts that
// audience (see google_sign_in.js). Public by design, like the config above.
export const GOOGLE_WEB_CLIENT_ID =
  "220067863446-6m0i5g5dj8i961c2um3bihe9kndoslfl.apps.googleusercontent.com";

// reCAPTCHA Enterprise site key for App Check (also public by design — it
// only works on the domains allow-listed on the key, not on localhost; dev
// builds use a registered debug token instead, see pref_sync.js).
export const RECAPTCHA_SITE_KEY = "6LcGjxstAAAAAIq3GZ9k34Ov6kKTJECZRa6xcF7y";
