/** Traduz mensagens de erro do Supabase Auth para pt-BR. */
export function translateAuthError(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("invalid login credentials")) return "Email ou senha incorretos.";
  if (m.includes("email not confirmed")) return "Confirme seu email antes de entrar.";
  if (m.includes("already registered") || m.includes("already exists")) return "Este email já está cadastrado.";
  if (m.includes("password should be at least") || m.includes("password is too short"))
    return "A senha deve ter pelo menos 6 caracteres.";
  if (m.includes("valid password")) return "Informe uma senha válida.";
  if (m.includes("invalid format") || m.includes("valid email")) return "Email inválido.";
  if (m.includes("rate limit") || m.includes("too many")) return "Muitas tentativas. Aguarde um pouco e tente de novo.";
  if (m.includes("network") || m.includes("fetch")) return "Sem conexão. Verifique sua internet.";
  return "Não foi possível concluir. Tente novamente.";
}
