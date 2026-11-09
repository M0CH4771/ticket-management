let authPromise=null,authState=null;
export async function initialize(config){
  if(!config?.apiKey||!config?.projectId)throw new Error('Firebase Authenticationの設定を確認してください');
  if(!authPromise)authPromise=Promise.all([
    import('https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js')
  ]).then(async([app,sdk])=>{
    const firebase=app.getApps().find(a=>a.name==='ticket-auth')||app.initializeApp(config,'ticket-auth');
    authState={sdk,auth:sdk.getAuth(firebase)};
    await new Promise(resolve=>{const unsubscribe=sdk.onAuthStateChanged(authState.auth,()=>{unsubscribe();resolve()})});
    window.LivePocketAuth={getIdToken:async()=>{const user=authState?.auth.currentUser;if(!user)throw new Error('Googleアカウントでログインしてください');return user.getIdToken()},currentUser:()=>authState?.auth.currentUser||null,signIn,signOut};
    return window.LivePocketAuth;
  }).catch(error=>{authPromise=null;throw error});
  return authPromise;
}
export async function currentUser(){return authState?.auth.currentUser||null}
export async function signIn(){
  if(!authState)throw new Error('ログインの準備ができていません');
  const provider=new authState.sdk.GoogleAuthProvider();
  provider.setCustomParameters({prompt:'select_account'});
  const result=await authState.sdk.signInWithPopup(authState.auth,provider);
  return result.user;
}
export async function signOut(){
  if(authState)await authState.sdk.signOut(authState.auth);
}