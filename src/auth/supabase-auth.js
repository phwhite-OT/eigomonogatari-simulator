const SUPABASE_URL = "https://jyrtaqciclwswukkmhxd.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_kNuBcDWwnrKsZEoUXyZwbQ_2_UeS3o0";

export function translateSupabaseAuthError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  const code = String(error?.code ?? "").toLowerCase();

  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "メールアドレスが未確認です。届いた確認メールのリンクを開いてからログインしてください。";
  }
  if (code === "invalid_credentials" || message.includes("invalid login credentials")) {
    return "メールアドレスまたはパスワードが正しくありません。";
  }
  if (code === "user_already_exists" || message.includes("user already registered")) {
    return "このメールアドレスはすでに登録されています。ログインするか、確認メールを確認してください。";
  }
  if (message.includes("password should be")) {
    return "パスワードは必要な文字数を満たしていません。";
  }
  if (message.includes("rate limit") || message.includes("too many requests")) {
    return "短時間に操作が集中しています。しばらく待ってからもう一度お試しください。";
  }
  if (message.includes("failed to fetch") || message.includes("network")) {
    return "認証サーバーに接続できませんでした。ネットワーク接続を確認してもう一度お試しください。";
  }
  return "認証処理に失敗しました。時間をおいてもう一度お試しください。";
}

export function createSupabaseAuthClient(supabaseLibrary = globalThis.supabase) {
  if (!supabaseLibrary?.createClient) {
    throw new Error("Supabase client is unavailable");
  }

  return supabaseLibrary.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}

function emailRedirectUrl(location = window.location) {
  return `${location.origin}${location.pathname}`;
}

function isValidInput(email, password) {
  return email.length > 0 && password.length > 0;
}

export async function initializeSupabaseAuth(root = document) {
  const status = root.querySelector("[data-auth-status]");
  const openButton = root.querySelector("[data-auth-open]");
  const logoutButton = root.querySelector("[data-auth-logout]");
  const dialog = root.querySelector("[data-auth-dialog]");
  const form = root.querySelector("[data-auth-form]");
  const emailInput = root.querySelector("[data-auth-email]");
  const passwordInput = root.querySelector("[data-auth-password]");
  const loginButton = root.querySelector("[data-auth-login]");
  const signupButton = root.querySelector("[data-auth-signup]");
  const message = root.querySelector("[data-auth-message]");
  const closeButtons = root.querySelectorAll("[data-auth-close]");

  if (!status || !openButton || !logoutButton || !dialog || !form || !emailInput || !passwordInput || !loginButton || !signupButton || !message) {
    return null;
  }

  let client;
  let busy = false;

  const setMessage = (text = "", isError = false) => {
    message.textContent = text;
    message.classList.toggle("is-error", isError);
  };

  const setBusy = (nextBusy) => {
    busy = nextBusy;
    loginButton.disabled = nextBusy;
    signupButton.disabled = nextBusy;
    emailInput.disabled = nextBusy;
    passwordInput.disabled = nextBusy;
  };

  const renderSession = (session) => {
    const email = session?.user?.email;
    status.textContent = email ? `${email} でログイン中` : "ログインしていません";
    openButton.hidden = Boolean(email);
    logoutButton.hidden = !email;
  };

  const openDialog = () => {
    setMessage();
    if (!dialog.open) dialog.showModal();
    emailInput.focus();
  };

  const closeDialog = () => {
    if (dialog.open) dialog.close();
  };

  const getCredentials = () => ({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });

  const validateCredentials = ({ email, password }) => {
    if (!isValidInput(email, password)) {
      setMessage("メールアドレスとパスワードを入力してください。", true);
      return false;
    }
    return true;
  };

  const signIn = async () => {
    if (busy) return;
    const credentials = getCredentials();
    if (!validateCredentials(credentials)) return;

    setBusy(true);
    setMessage("ログインしています…");
    try {
      const { error } = await client.auth.signInWithPassword(credentials);
      if (error) throw error;
      setMessage("ログインしました。");
      closeDialog();
    } catch (error) {
      setMessage(translateSupabaseAuthError(error), true);
    } finally {
      setBusy(false);
    }
  };

  const signUp = async () => {
    if (busy) return;
    const credentials = getCredentials();
    if (!validateCredentials(credentials)) return;

    setBusy(true);
    setMessage("アカウントを登録しています…");
    try {
      const { error } = await client.auth.signUp({
        ...credentials,
        options: { emailRedirectTo: emailRedirectUrl() },
      });
      if (error) throw error;
      setMessage("確認メールを送信しました。メール内のリンクを開いてからログインしてください。");
    } catch (error) {
      setMessage(translateSupabaseAuthError(error), true);
    } finally {
      setBusy(false);
    }
  };

  try {
    client = createSupabaseAuthClient();
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    renderSession(data.session);
  } catch (error) {
    status.textContent = "ログイン機能を利用できません";
    setMessage("ログイン機能の読み込みに失敗しました。ページを再読み込みしてください。", true);
    openButton.disabled = true;
    return null;
  }

  client.auth.onAuthStateChange((_event, session) => renderSession(session));

  openButton.addEventListener("click", openDialog);
  logoutButton.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    } catch (error) {
      setMessage(translateSupabaseAuthError(error), true);
      openDialog();
    } finally {
      setBusy(false);
    }
  });
  closeButtons.forEach((button) => button.addEventListener("click", closeDialog));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void signIn();
  });
  signupButton.addEventListener("click", () => void signUp());

  return { client, signIn, signUp };
}
