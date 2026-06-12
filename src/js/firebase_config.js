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

// reCAPTCHA Enterprise site key for App Check (also public by design — it
// only works on the domains allow-listed on the key, not on localhost; dev
// builds use a registered debug token instead, see pref_sync.js).
export const RECAPTCHA_SITE_KEY = "6LcGjxstAAAAAIq3GZ9k34Ov6kKTJECZRa6xcF7y";
