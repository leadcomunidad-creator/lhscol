import { initializeApp } from 'firebase/app';
import type { FirebaseApp } from 'firebase/app';
import { ReCaptchaV3Provider, getToken, initializeAppCheck } from 'firebase/app-check';

const env = import.meta.env;
let tokenProvider: Promise<string> | undefined;
let firebaseApp: FirebaseApp | undefined;

export function configuredFirebaseApp(): FirebaseApp {
  if (!firebaseApp) {
    if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_APP_ID) throw new Error('La aplicación aún no está configurada.');
    firebaseApp = initializeApp({
      apiKey: env.VITE_FIREBASE_API_KEY,
      authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: env.VITE_FIREBASE_PROJECT_ID,
      appId: env.VITE_FIREBASE_APP_ID
    });
  }
  return firebaseApp;
}

export function appCheckToken(): Promise<string> {
  if (!tokenProvider) {
    tokenProvider = (async () => {
      if (!env.VITE_RECAPTCHA_SITE_KEY) {
        throw new Error('La inscripción aún no está configurada.');
      }
      const appCheck = initializeAppCheck(configuredFirebaseApp(), { provider: new ReCaptchaV3Provider(env.VITE_RECAPTCHA_SITE_KEY), isTokenAutoRefreshEnabled: true });
      return (await getToken(appCheck, false)).token;
    })();
  }
  return tokenProvider;
}
