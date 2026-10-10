"use strict";

const dns = require("dns");
const { execFile } = require("child_process");
const axios = require("axios");

dns.setDefaultResultOrder("ipv4first");
require("dotenv").config({ quiet: true });

const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");

const TOKEN = process.env.TOKEN;
const CANAL_ID = process.env.CANAL_ID;
const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_PORT = Number(process.env.PROXY_PORT);
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD;

if (
  !TOKEN ||
  !CANAL_ID ||
  !PROXY_HOST ||
  !PROXY_PORT ||
  !PROXY_USER ||
  !PROXY_PASSWORD
) {
  console.error("Configure TOKEN, CANAL_ID e PROXY no .env antes de iniciar.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const ARQUIVO_SENTINELAS = path.join(__dirname, "sentinelas.json");
const ARQUIVO_CUPONS = path.join(__dirname, "cupons-postados.json");
const ARQUIVO_PROMOTIONS = path.join(__dirname, "promotion-aberturas.json");
const IMAGEM_INDEX_FILE = path.join(__dirname, "imagem-index.json");
const AFILIADOS_FILE = path.join(__dirname, "afiliacao.json");
const LIMITE_ABERTURAS_PROMOTION = 2;
const ARQUIVO_PROMOTIONS_IGNORADAS = path.join(
  __dirname,
  "promotions-ignoradas.json"
);

function promotionIgnorada(id) {
  if (!fs.existsSync(ARQUIVO_PROMOTIONS_IGNORADAS)) {
    return false;
  }

  try {
    const ids = JSON.parse(
      fs.readFileSync(ARQUIVO_PROMOTIONS_IGNORADAS, "utf8")
    );

    return Array.isArray(ids) &&
      ids.includes(id.toUpperCase());

  } catch (err) {
    console.error("Erro na lista de promotions ignoradas:", err.message);
    return false;
  }
}

const QUANTIDADE_LINKS = 4;
const INTERVALO_PRODUTOS_MS = 2000;
const REQUEST_TIMEOUT = 15000;

const cuponsPostados = new Map();
const historicoPromotions = new Map();
const andamentoPopups = new Map();
let sentinelas = [];
let AFILIADOS = {};
let imagemIndex = 0;
let aguardandoLinksChatId = null;
let monitorandoAgora = false;
let ultimoSlot = "";

function agoraSP() { return moment().tz("America/Sao_Paulo"); }
function dormir(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function requisitarAmazon(url) {
  return new Promise((resolve, reject) => {
    const proxy =
      `http://${PROXY_USER}:${PROXY_PASSWORD}@${PROXY_HOST}:${PROXY_PORT}`;

    execFile(
      "curl",
      [
        "-sS",
        "-L",
        "--compressed",
        "--max-time",
        String(Math.ceil(REQUEST_TIMEOUT / 1000)),
        "-x",
        proxy,
        url,
        "-H",
        "User-Agent: Mozilla/5.0",
        "-H",
        "Accept-Language: pt-BR,pt;q=0.9",
        "-w",
        "\n__HTTP_STATUS__:%{http_code}"
      ],
      {
        maxBuffer: 5 * 1024 * 1024,
        encoding: "utf8"
      },
      (erro, stdout, stderr) => {
        const marcador = "\n__HTTP_STATUS__:";
        const posicao = stdout.lastIndexOf(marcador);

        if (posicao === -1) {
          return reject(
            new Error(
              erro?.message ||
              stderr ||
              "Resposta inválida do curl"
            )
          );
        }

        const html =
          stdout.slice(0, posicao);

        const status =
          Number(
            stdout
              .slice(posicao + marcador.length)
              .trim()
          );

        resolve({
          status,
          data: html
        });
      }
    );
  });
}
function carregarJSON(arquivo, padrao) {
  if (!fs.existsSync(arquivo)) return padrao;
  try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); }
  catch (e) { console.error("JSON inválido:", path.basename(arquivo), e.message); throw e; }
}
function salvarJSON(arquivo, dados) {
  const temporario = arquivo + ".tmp";
  fs.writeFileSync(temporario, JSON.stringify(dados, null, 2));
  fs.renameSync(temporario, arquivo);
}
function salvarCuponsPostados() { salvarJSON(ARQUIVO_CUPONS, Object.fromEntries(cuponsPostados)); }
function salvarHistoricoPromotions() { salvarJSON(ARQUIVO_PROMOTIONS, Object.fromEntries(historicoPromotions)); }
function salvarSentinelas() { salvarJSON(ARQUIVO_SENTINELAS, sentinelas); }
function carregarEstado() {
  for (const [codigo, tempo] of Object.entries(carregarJSON(ARQUIVO_CUPONS, {}))) {
    cuponsPostados.set(codigo, tempo);
  }
  for (const [id, registro] of Object.entries(carregarJSON(ARQUIVO_PROMOTIONS, {}))) {
    if (!registro || !Array.isArray(registro.extras)) continue;
    const codigosPostados = Array.isArray(registro.codigosPostados) ? registro.codigosPostados : [];
    if (codigosPostados.some(codigo => !cuponsPostados.has(codigo))) continue;
    historicoPromotions.set(id, {
      sucessos: Math.min(2, Math.max(0, Number(registro.sucessos) || 0)),
      extras: registro.extras,
      codigosPostados
    });
  }
  sentinelas = carregarJSON(ARQUIVO_SENTINELAS, []);
  AFILIADOS = carregarJSON(AFILIADOS_FILE, {});
  imagemIndex = Number(carregarJSON(IMAGEM_INDEX_FILE, { index: 0 }).index) || 0;
  if (sentinelas.length !== QUANTIDADE_LINKS) {
    console.warn(`AVISO: configure exatamente ${QUANTIDADE_LINKS} links em sentinelas.json ou /links.`);
  }
}
function marcarPromotionPostada(id, codigo) {
  const registro = historicoPromotions.get(id);
  if (!registro) return;
  if (!registro.codigosPostados.includes(codigo)) {
    registro.codigosPostados.push(codigo);
    salvarHistoricoPromotions();
  }
}
function limparContagemDoCupom(codigo) {
  let alterou = false;
  for (const [id, registro] of historicoPromotions) {
    if (registro.extras.some(extra => extra.codigo === codigo) || registro.codigosPostados.includes(codigo)) {
      historicoPromotions.delete(id);
      alterou = true;
    }
  }
  if (alterou) salvarHistoricoPromotions();
}
function limparCuponsExpirados() {
  const agora = Date.now();
  for (const [codigo, timestamp] of cuponsPostados) {
    if (typeof timestamp !== "number" || timestamp <= 0) continue;
    if (agora - timestamp >= 24 * 60 * 60 * 1000) {
      cuponsPostados.delete(codigo);
      limparContagemDoCupom(codigo);
      console.log("Cupom liberado após 24h:", codigo);
    }
  }
  salvarCuponsPostados();
}
function obterProximaImagem() {
  const pasta = path.join(__dirname, "imagem");
  if (!fs.existsSync(pasta)) throw new Error("Pasta imagem não encontrada.");
  const imagens = fs.readdirSync(pasta).filter(x => /\.(jpe?g|png)$/i.test(x)).sort();
  if (!imagens.length) throw new Error("Insira ao menos uma imagem na pasta imagem.");
  imagemIndex %= imagens.length;
  const selecionada = path.join(pasta, imagens[imagemIndex]);
  imagemIndex = (imagemIndex + 1) % imagens.length;
  salvarJSON(IMAGEM_INDEX_FILE, { index: imagemIndex });
  return selecionada;
}
function obterLinkAfiliado(url) {
  const asin = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  return (asin && AFILIADOS[asin]) || url;
}

// HTML DE PRODUTO: APENAS DESCOBERTA DE IDs (3 formatos).
function extrairIds(html) {
  const regexes = [
    /promotion\/details\/popup\/([A-Z0-9]+)/gi,
    /amzn1\.promotion\.([A-Z0-9]+)/gi,
    /promotionId=([A-Z0-9]+)/gi
  ];
  const ids = new Set();
  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(html)) !== null) ids.add(match[1].toUpperCase());
  }
  return [...ids];
}

// POPUP: FONTE ÚNICA DOS DADOS COMPLETOS.
// Mantém as regex originais e acrescenta o formato de termos confirmado no teste.
function extrairCuponsPopup(html) {
  const resultados = [];
  const jaVistos = new Set();
  const texto = html.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ");
  const fontes = [texto, html];
  function acrescentar(item) {
    const chave = [item.codigo, item.porcentagem, item.valorReais, item.minimo, item.limite].join("|");
    if (!jaVistos.has(chave)) { jaVistos.add(chave); resultados.push(item); }
  }
  const regexOriginal = /Ganhe\s+(?:(\d+)%|(?:R\$)?\s*([\d.,]+))(?:\s*off)?(?=[\s\S]*?R\$\s*([\d.,]+)[\s\S]*?O benefício máximo que você pode receber com esta promoção é limitado a\s*(?:R\$)?\s*([\d.,]+))(?=[\s\S]*?Cupom de desconto:\s*(?:<groupClaimCode>)?([A-Z0-9]+)(?:<\/groupClaimCode>)?)/gi;
  const regexSemMinimo = /Ganhe\s+(?:(\d+)%|(?:R\$)?\s*([\d.,]+))(?:\s*off)?[\s\S]*?O benefício máximo que você pode receber com esta promoção é limitado a\s*(?:R\$)?\s*([\d.,]+)[\s\S]*?Cupom de desconto:\s*(?:<groupClaimCode>)?([A-Z0-9]+)(?:<\/groupClaimCode>)?/gi;
  for (const fonte of fontes) {
    regexOriginal.lastIndex = 0;
    let match;
    while ((match = regexOriginal.exec(fonte)) !== null) {
      acrescentar({ tipo: "cupomCompleto", porcentagem: match[1] || null, valorReais: match[2] || null, minimo: match[3], limite: match[4], codigo: match[5].toUpperCase() });
    }
  }
  if (!resultados.length) {
    for (const fonte of fontes) {
      regexSemMinimo.lastIndex = 0;
      let match;
      while ((match = regexSemMinimo.exec(fonte)) !== null) {
        acrescentar({ tipo: "cupomCompleto", porcentagem: match[1] || null, valorReais: match[2] || null, minimo: null, limite: match[3], codigo: match[4].toUpperCase() });
      }
    }
  }
  // Formato real encontrado no popup: "Ganhe 10% off em compras a partir de R$ 150 (limitado a R$ 30)."
  // Os termos podem estar como \n JSON e conter <groupClaimCode>.
  if (!resultados.length) {
    const padraoAtual = /Ganhe\s+(?:(\d+)%|R\$\s*([\d.,]+))\s*off(?:\s+em\s+compras\s+a\s+partir\s+de\s+R\$\s*([\d.,]+))?\s*\(limitado\s+a\s+R\$\s*([\d.,]+)\)[\s\S]{0,1000}?Cupom de desconto:\s*(?:<groupClaimCode>)?([A-Z0-9]+)(?:<\/groupClaimCode>)?/gi;
    for (const fonte of fontes) {
      padraoAtual.lastIndex = 0;
      let match;
      while ((match = padraoAtual.exec(fonte)) !== null) {
        acrescentar({ tipo: "cupomCompleto", porcentagem: match[1] || null, valorReais: match[2] || null, minimo: match[3] || null, limite: match[4], codigo: match[5].toUpperCase() });
      }
    }
  }
  return resultados;
}

async function obterExtrasPromotion(id) {

  if (promotionIgnorada(id)) {
    return [];
  }

  if (andamentoPopups.has(id)) {
    return andamentoPopups.get(id);
  }

  const tarefa = (async () => {
    const registro = historicoPromotions.get(id);
    // Qualquer cupom deste ID já publicado: parar novas consultas.
    if (registro?.codigosPostados.some(codigo => cuponsPostados.has(codigo))) {
      return registro.extras;
    }
    if (registro?.sucessos >= LIMITE_ABERTURAS_PROMOTION) return registro.extras;
    let resposta = null;
    let html = "";

    for (let tentativa = 1; tentativa <= 5; tentativa++) {

      resposta = await requisitarAmazon(
        `https://www.amazon.com.br/promotion/details/popup/${id}`
      );

      html = resposta.data;

      const valido =
        resposta.status === 200 &&
        typeof html === "string" &&
        html.includes("promo_tnc_popup_container_") &&
        html.includes("tncSectionContentMap") &&
        !/captcha|enter the characters|digite os caracteres/i.test(html);

      if (valido) {
        console.log(
          "Popup respondeu:",
          id,
          `tentativa ${tentativa}/5`
        );
        break;
      }

      console.log(
        "Popup inválido:",
        id,
        `tentativa ${tentativa}/5`,
        "status:",
        resposta.status,
        "resposta:",
        String(resposta.data || "").slice(0, 500)
      );

      html = "";
    }

    if (!html) {
      console.log(
        "Popup falhou após 5 IPs:",
        id
      );
      return [];
    }

    const extras = extrairCuponsPopup(html);
    historicoPromotions.set(id, {
      sucessos: Math.min(LIMITE_ABERTURAS_PROMOTION, (registro?.sucessos || 0) + 1),
      extras: extras.length ? extras : (registro?.extras || []),
      codigosPostados: registro?.codigosPostados || []
    });
    salvarHistoricoPromotions();
    console.log("Popup válido:", id, `${historicoPromotions.get(id).sucessos}/2`, "cupons completos:", extras.length);
    return historicoPromotions.get(id).extras;
  })();
  andamentoPopups.set(id, tarefa);
  try { return await tarefa; }
  finally { andamentoPopups.delete(id); }
}

async function consultarProduto(url) {

  for (let tentativa = 1; tentativa <= 5; tentativa++) {

    try {

      const resposta = await axios.get(url, {
        proxy: {
          protocol: "http",
          host: PROXY_HOST,
          port: PROXY_PORT,
          auth: {
            username: PROXY_USER,
            password: PROXY_PASSWORD
          }
        },
        timeout: REQUEST_TIMEOUT,
        headers: {
          "user-agent": "Mozilla/5.0",
          "accept-language": "pt-BR,pt;q=0.9",
          "accept-encoding": "gzip, deflate, br"
        }
      });

      const html = resposta.data;

      if (
        resposta.status !== 200 ||
        typeof html !== "string" ||
        /captcha|enter the characters|digite os caracteres/i.test(html) ||
        !html.includes("amzn1.asin.")
      ) {
        console.log(
          "Produto inválido:",
          url,
          `tentativa ${tentativa}/5`
        );

        continue;
      }

      const ids = extrairIds(html);

      console.log(
        "Produto:",
        url,
        "IDs:",
        ids,
        `tentativa ${tentativa}/5`
      );

      return ids;

    } catch (err) {

      console.log(
        "Erro produto:",
        url,
        `tentativa ${tentativa}/5`,
        err.response?.status || err.message
      );
    }
  }

  console.log(
    "Produto falhou após 5 tentativas:",
    url
  );

  return [];
}

function formatarMensagem(item, linkAmazon) {
  const observacao = item.vendaTerceiros ? "vendedores terceiros (não Amazon)\n" : "";
  if (item.porcentagem) {
    return `Cupom AMAZON App\n\n${item.limite ? `${item.porcentagem}% até <b>R$${item.limite} OFF</b>` : `<b>${item.porcentagem}% OFF</b>`} 🔑 <code>${item.codigo}</code>\n${item.minimo ? `acima de R$${String(item.minimo).replace(/[.,]$/, "").replace(",", ".")}\n` : ""}\n${observacao}<b>🔗 Resgate no link 👉: ${linkAmazon}</b>\n# Anuncio @paradoxopromos`;
  }
  if (item.valorReais) {
    const minimo = item.minimo ? ` em R$${String(item.minimo).replace(/[.,]$/, "")}` : "";
    return `Cupom AMAZON App\n\n<b>R$${item.valorReais} OFF</b>${minimo} 🔑 <code>${item.codigo}</code>\n\n${observacao}<b>🔗 Resgate no link 👉: ${linkAmazon}</b>\n# Anuncio @paradoxopromos`;
  }
  throw new Error("Desconto não reconhecido");
}

async function monitorar(nome) {
  if (monitorandoAgora) { console.log("Varredura ignorada: anterior ainda em andamento."); return; }
  if (sentinelas.length !== QUANTIDADE_LINKS) { console.log("Configure 4 links antes de monitorar."); return; }
  monitorandoAgora = true;
  console.log(`[${agoraSP().format("HH:mm:ss")}] ${nome}`);
  try {
    // Agenda inícios espaçados em 2s, sem esperar cada download concluir.
    const capturas = [];
    for (let i = 0; i < sentinelas.length; i++) {
      if (i) await dormir(INTERVALO_PRODUTOS_MS);
      capturas.push(consultarProduto(sentinelas[i]));
    }
    const conjuntosIds = await Promise.all(capturas);
    const idsParaUrls = new Map();
    for (let i = 0; i < conjuntosIds.length; i++) {
      for (const id of conjuntosIds[i]) {
        if (!idsParaUrls.has(id)) idsParaUrls.set(id, []);
        idsParaUrls.get(id).push(sentinelas[i]);
      }
    }
    console.log("IDs únicos:", [...idsParaUrls.keys()]);
    // A ronda inteira compartilha IDs deduplicados: um popup por ID.
    for (const [id, urls] of idsParaUrls) {
      try {
        const extras = await obterExtrasPromotion(id);
        for (const item of extras) {
          if (item.tipo !== "cupomCompleto" || !item.codigo || cuponsPostados.has(item.codigo)) continue;
          const url = urls[0];
          const linkAmazon = obterLinkAfiliado(url);
          const texto = formatarMensagem(item, linkAmazon);
          const imagem = obterProximaImagem();
          // Somente marca como enviado APÓS confirmação do Telegram.
          await bot.sendPhoto(CANAL_ID, imagem, { caption: texto, parse_mode: "HTML" });
          cuponsPostados.set(item.codigo, Date.now());
          salvarCuponsPostados();
          marcarPromotionPostada(id, item.codigo);
          console.log("Cupom enviado:", item.codigo, "promotion:", id);
        }
      } catch (err) {
        console.log("Erro popup/postagem:", id, err.response?.status || err.message);
      }
    }
  } catch (err) {
    console.log("Erro varredura:", err.message);
  } finally { monitorandoAgora = false; }
}

// Horários Brasília: 07h..23h (:00:00, :00:10, :30:00); 00:00:00 e 00:00:10.
function slotProgramado(agora) {
  const h = Number(agora.format("H"));
  const m = Number(agora.format("m"));
  const s = Number(agora.format("s"));
  if (!(h === 0 || (h >= 7 && h <= 23))) return null;
  if (m === 0 && (s === 0 || s === 10)) return "HORA-CHEIA";
  if (h >= 7 && h <= 23 && m === 30 && s === 0) return "MEIA-HORA";
  return null;
}
setInterval(() => {
  const agora = agoraSP();
  const modo = slotProgramado(agora);
  if (!modo) return;
  const chave = agora.format("YYYY-MM-DD HH:mm:ss");
  if (chave === ultimoSlot) return;
  ultimoSlot = chave;
  monitorar(modo).catch(err => console.log("Erro agendamento:", err.message));
}, 250);
setInterval(limparCuponsExpirados, 5 * 60 * 1000);

bot.onText(/^\/links(?:@\w+)?$/, async (msg) => {
  if (msg.chat.type !== "private") return;
  aguardandoLinksChatId = msg.chat.id;
  await bot.sendMessage(msg.chat.id, "Envie exatamente 4 links Amazon, um por linha.");
});
bot.on("message", async msg => {
  if (aguardandoLinksChatId !== msg.chat.id || !msg.text || msg.text.startsWith("/")) return;
  const links = [...new Set(msg.text.split("\n").map(x => x.trim()).filter(Boolean))];
  if (links.length !== 4 || !links.every(x => /^https:\/\/(?:www\.)?amazon\.com\.br\/.+\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(x))) {
    await bot.sendMessage(msg.chat.id, "Envie exatamente 4 URLs completas de produtos amazon.com.br com /dp/ASIN.");
    return;
  }
  sentinelas = links;
  salvarSentinelas();
  aguardandoLinksChatId = null;
  await bot.sendMessage(msg.chat.id, "✅ 4 links salvos. Varreduras às HH:00:00, HH:00:10 e HH:30:00 (07h a 00h). Produtos espaçados em 2 segundos.");
});
bot.on("polling_error", err => console.log("Telegram polling:", err.message));

carregarEstado();
console.log("ELIPSE INICIADO — 4 produtos, proxy residencial rotativo, 53 varreduras/dia.");
