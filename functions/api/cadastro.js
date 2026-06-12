/**
 * Cloudflare Pages Function — POST /api/cadastro
 *
 * Fluxo:
 *  1. Valida nome e email.
 *  2. Verifica se o email já existe em trials/{email} → erro "email_ja_cadastrado".
 *  3. Busca o domínio em dominios_liberados/{dominio}:
 *     - aprovacao "automatica"/"automatico" → cria trial ativo (30 dias) + email de boas-vindas.
 *     - caso contrário → cria trial "aguardando" + email de cadastro recebido.
 *
 * Firestore é acessado via API REST com a apiKey pública do Firebase
 * (runtime do Workers não suporta o SDK Node.js do Firebase).
 *
 * Variáveis de ambiente (configurar no Cloudflare Pages → Settings → Environment variables):
 *  - RESEND_API_KEY  (obrigatória — nunca hardcoded)
 *  - FROM_EMAIL      (opcional, padrão: contato@brandtail.ai)
 *  - CHROME_STORE_URL (opcional, link da extensão no email de boas-vindas)
 */

const FIREBASE_PROJECT_ID = "insite-pm-cfd89";
const FIREBASE_API_KEY = "AIzaSyBnYVri-kPxnQZe9LD7rsZTscnWPpQ1PmA";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const TRIAL_DAYS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "dados_invalidos", message: "Corpo da requisição inválido." }, 400);
  }

  const nome = String(body.nome || "").trim();
  const email = String(body.email || "").trim().toLowerCase();

  if (nome.length < 3 || !EMAIL_RE.test(email)) {
    return json({ success: false, error: "dados_invalidos", message: "Nome e email válidos são obrigatórios." }, 400);
  }

  const dominio = email.split("@")[1];

  try {
    // 1. Email já cadastrado?
    const existing = await firestoreGet(`trials/${encodeURIComponent(email)}`);
    if (existing.ok) {
      return json({ success: false, error: "email_ja_cadastrado", message: "Este email já está cadastrado" }, 409);
    }
    if (existing.status !== 404) {
      throw new Error(`Firestore (trials) respondeu ${existing.status}: ${await existing.text()}`);
    }

    // 2. Domínio liberado para aprovação automática?
    let aprovacaoAutomatica = false;
    const domRes = await firestoreGet(`dominios_liberados/${encodeURIComponent(dominio)}`);
    if (domRes.ok) {
      const domDoc = await domRes.json();
      const aprovacao = domDoc.fields?.aprovacao?.stringValue || "";
      aprovacaoAutomatica = aprovacao === "automatica" || aprovacao === "automatico";
    } else if (domRes.status !== 404) {
      throw new Error(`Firestore (dominios_liberados) respondeu ${domRes.status}: ${await domRes.text()}`);
    }

    const agora = new Date();

    if (aprovacaoAutomatica) {
      const trialEnd = new Date(agora.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

      await firestoreCreateTrial(email, {
        nome: { stringValue: nome },
        email: { stringValue: email },
        dominio: { stringValue: dominio },
        status: { stringValue: "ativo" },
        trial_start: { timestampValue: agora.toISOString() },
        trial_end: { timestampValue: trialEnd.toISOString() },
        aprovado_por: { stringValue: "automatico" },
        criado_em: { timestampValue: agora.toISOString() },
      });

      await sendEmail(env, {
        to: email,
        subject: "Seu acesso ao InSite está liberado 🎉",
        text: emailBoasVindas(nome, email, trialEnd, env),
      });

      return json({ success: true, tipo: "automatico" });
    }

    // Domínio não liberado → aguardando aprovação manual
    await firestoreCreateTrial(email, {
      nome: { stringValue: nome },
      email: { stringValue: email },
      dominio: { stringValue: dominio },
      status: { stringValue: "aguardando" },
      trial_start: { nullValue: null },
      trial_end: { nullValue: null },
      aprovado_por: { nullValue: null },
      criado_em: { timestampValue: agora.toISOString() },
    });

    await sendEmail(env, {
      to: email,
      subject: "Recebemos seu cadastro no InSite",
      text: emailCadastroRecebido(nome, email),
    });

    return json({ success: true, tipo: "aguardando" });
  } catch (err) {
    console.error("Erro em /api/cadastro:", err);
    return json({ success: false, error: "erro_interno", message: "Erro interno. Tente novamente." }, 500);
  }
}

/* ---------- Firestore (API REST, fetch nativo) ---------- */

function firestoreGet(path) {
  return fetch(`${FIRESTORE_BASE}/${path}?key=${FIREBASE_API_KEY}`);
}

async function firestoreCreateTrial(email, fields) {
  // PATCH em trials/{email} cria o documento com o email como ID.
  const res = await fetch(
    `${FIRESTORE_BASE}/trials/${encodeURIComponent(email)}?key=${FIREBASE_API_KEY}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }
  );
  if (!res.ok) {
    throw new Error(`Falha ao criar trial no Firestore (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/* ---------- Resend ---------- */

async function sendEmail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY não configurada — email não enviado para", to);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `BrandTail.AI <${env.FROM_EMAIL || "contato@brandtail.ai"}>`,
      to: [to],
      subject,
      text,
      reply_to: "jefg5@yahoo.com.br",
    }),
  });
  if (!res.ok) {
    // Falha de email não deve impedir o cadastro — apenas registrar.
    console.error(`Resend respondeu ${res.status}: ${await res.text()}`);
  }
}

/* ---------- Templates de email ---------- */

function emailBoasVindas(nome, email, trialEnd, env) {
  const linkChromeStore = env.CHROME_STORE_URL || "[LINK DA CHROME STORE]";
  return `Olá, ${nome}!

Seu trial gratuito de ${TRIAL_DAYS} dias do InSite está ativo.

Para começar:
1. Instale a extensão Chrome: ${linkChromeStore}
2. Abra a extensão e informe seu email: ${email}
3. Pronto — você já tem acesso completo!

Seu trial é válido até: ${formatDateBR(trialEnd)}

Qualquer dúvida, responda este email.

Equipe BrandTail.AI`;
}

function emailCadastroRecebido(nome, email) {
  return `Olá, ${nome}!

Recebemos seu pedido de acesso ao InSite.

Nossa equipe irá analisar seu cadastro e você receberá
uma resposta em até 48 horas úteis no email: ${email}

Enquanto isso, saiba mais sobre o InSite em: brandtail.ai

Equipe BrandTail.AI`;
}

function formatDateBR(date) {
  const d = String(date.getUTCDate()).padStart(2, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const y = date.getUTCFullYear();
  return `${d}/${m}/${y}`;
}

/* ---------- Util ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
