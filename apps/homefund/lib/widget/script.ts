// The Scriptable script of the iPhone widget (RF-215), as text: the app serves it and Ajustes copies it.
// It holds no backtick and no `${`, so it stays a raw template; `__SITE__` is swapped for the app's origin.
const SOURCE = String.raw`// HomeFund · widget del iPhone para Scriptable.
// Los textos están en español aquí y no en next-intl: es un script que se descarga y se copia, no una pantalla de la app.
var BASE = __SITE__;
var API = BASE + "/api/widget";
var INBOX = BASE + "/es/inbox";
var KEY = "homefund-widget-key";
var CACHE = "homefund-widget-cache";
var PRIVATE = "homefund-widget-private";

var INK = Color.dynamic(new Color("#1f1d2b"), new Color("#f4f2ff"));
var GRAY = new Color("#8e8ea0");
var RED = new Color("#e5484d");
var AMBER = new Color("#f5a524");

// Sin mayúsculas ni tildes: «Privado» y «privádo» se leen igual.
function fold(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

// El parámetro del widget manda: «privado» u «oculto» esconde los montos, «visible» los muestra; sin parámetro vale lo guardado.
function isHidden() {
  var parameter = fold(args.widgetParameter);
  if (parameter === "privado" || parameter === "oculto") return true;
  if (parameter === "visible") return false;
  return Keychain.contains(PRIVATE) && Keychain.get(PRIVATE) === "1";
}

// Pesos sin centavos: 123456789 centavos son «$1.234.567».
function pesos(cents, currency, hidden) {
  if (hidden) return (currency === "COP" ? "$" : currency) + " •••••";
  var whole = Math.floor((Math.abs(cents) + 50) / 100);
  var grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  var prefix = currency === "COP" ? "$" : currency + " ";
  return (cents < 0 && whole > 0 ? "-" : "") + prefix + grouped;
}

async function askKey(message) {
  var alert = new Alert();
  alert.title = "Clave del widget";
  alert.message = message;
  alert.addTextField("Clave", "");
  alert.addAction("Guardar");
  alert.addCancelAction("Cancelar");
  if ((await alert.presentAlert()) !== 0) return null;
  var key = alert.textFieldValue(0).trim();
  if (key === "") return null;
  Keychain.set(KEY, key);
  return key;
}

// Fails with "offline" when the phone cannot reach HomeFund, "key" when the key is refused.
async function load(key) {
  var request = new Request(API);
  request.headers = { Authorization: "Bearer " + key };
  request.timeoutInterval = 15;
  var data;
  try {
    data = await request.load();
  } catch (error) {
    throw new Error("offline");
  }
  var status = request.response.statusCode;
  if (status === 401) throw new Error("key");
  if (status !== 200) throw new Error("server");
  return JSON.parse(data.toRawString());
}

function text(parent, value, size, color, bold) {
  var line = parent.addText(value);
  line.font = bold ? Font.boldSystemFont(size) : Font.systemFont(size);
  line.textColor = color;
  line.lineLimit = 1;
  line.minimumScaleFactor = 0.5;
  return line;
}

// «John: pagó ✓ · cuota en 6 días»: whether the person who pays the credit sent their part this month.
function creditLine(credit) {
  var paid = credit.paidThisMonth === "done" ? "pagó ✓" : credit.paidThisMonth === "partial" ? "pagó una parte" : "sin pago";
  var days = credit.daysUntilDue;
  var due = days === null ? "" : days === 0 ? " · cuota hoy" : " · cuota en " + days + (days === 1 ? " día" : " días");
  return credit.person + ": " + paid + due;
}

function render(data, family, stale, hidden) {
  var widget = new ListWidget();
  widget.url = INBOX;
  widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  var currency = data.currency;
  var available = pesos(data.disponible.cents, currency, hidden);
  var spent = data.mes.spentCents;
  var budgeted = data.mes.budgetedCents;
  var pending = data.bandeja.pendingCount;
  var month = budgeted > 0 ? pesos(spent, currency, hidden) + " de " + pesos(budgeted, currency, hidden) : pesos(spent, currency, hidden);
  var inbox = pending === 0 ? "Bandeja al día" : pending + " por revisar";

  if (family === "accessoryInline") {
    widget.addText("Disponible " + available + (pending > 0 ? " · " + pending : ""));
    return widget;
  }
  if (family === "accessoryCircular") {
    widget.addText(String(pending));
    return widget;
  }
  if (family === "accessoryRectangular") {
    widget.addText("Disponible " + available);
    widget.addText("Mes " + month);
    widget.addText(inbox);
    return widget;
  }

  widget.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#110c20"));
  var over = budgeted > 0 && spent > budgeted;
  if (family === "small") {
    widget.setPadding(14, 14, 14, 14);
    text(widget, "HomeFund", 11, GRAY, true);
    widget.addSpacer(4);
    text(widget, "Disponible", 12, GRAY, false);
    text(widget, available, 22, INK, true);
    widget.addSpacer();
    text(widget, "Mes " + month, 11, over ? RED : INK, false);
    text(widget, stale ? "Sin conexión" : inbox, 11, pending > 0 && !stale ? AMBER : GRAY, false);
    return widget;
  }

  widget.setPadding(16, 16, 16, 16);
  text(widget, "HomeFund", 11, GRAY, true);
  widget.addSpacer(6);
  var row = widget.addStack();
  var left = row.addStack();
  left.layoutVertically();
  text(left, "Disponible", 12, GRAY, false);
  text(left, available, 26, INK, true);
  row.addSpacer();
  var right = row.addStack();
  right.layoutVertically();
  text(right, "Gastado este mes", 12, GRAY, false);
  text(right, month, 15, over ? RED : INK, true);
  var credits = data.creditos || [];
  if (credits.length > 0) {
    widget.addSpacer(6);
    for (var i = 0; i < Math.min(credits.length, 3); i++) {
      text(widget, creditLine(credits[i]), 12, credits[i].paidThisMonth === "done" ? INK : AMBER, false);
    }
    if (credits.length > 3) text(widget, "y " + (credits.length - 3) + " más", 11, GRAY, false);
  }
  widget.addSpacer();
  text(widget, stale ? "Sin conexión · datos guardados" : inbox, 12, pending > 0 && !stale ? AMBER : GRAY, false);
  return widget;
}

function message(value) {
  var widget = new ListWidget();
  widget.url = INBOX;
  text(widget, "HomeFund", 11, GRAY, true);
  widget.addSpacer(4);
  var line = widget.addText(value);
  line.font = Font.systemFont(13);
  return widget;
}

// El menú al correr el script dentro de Scriptable; false cuando se cierra sin elegir.
async function menu() {
  var hidden = isHidden();
  var alert = new Alert();
  alert.title = "HomeFund";
  alert.message = "Ocultar montos vale para los widgets sin parámetro. Con el parámetro «privado» u «oculto» un widget siempre los oculta, y con «visible» siempre los muestra.";
  alert.addAction("Ver widget");
  alert.addAction(hidden ? "Mostrar montos" : "Ocultar montos");
  alert.addAction("Cambiar llave");
  alert.addCancelAction("Cerrar");
  var choice = await alert.presentAlert();
  if (choice === 1) Keychain.set(PRIVATE, hidden ? "0" : "1");
  if (choice === 2) await askKey("Pega la llave nueva. La anterior deja de usarse en este teléfono.");
  return choice >= 0;
}

async function main() {
  var family = config.widgetFamily || "medium";
  var key = Keychain.contains(KEY) ? Keychain.get(KEY) : null;
  if (key === null && config.runsInApp) {
    key = await askKey("Pega la clave que creaste en HomeFund, en Ajustes › Widget del iPhone.");
  }
  if (key !== null && config.runsInApp) {
    if (!(await menu())) {
      Script.complete();
      return;
    }
    key = Keychain.contains(KEY) ? Keychain.get(KEY) : null;
  }
  var hidden = isHidden();

  var widget;
  if (key === null) {
    widget = message("Abre este script en Scriptable y pega tu clave.");
  } else {
    try {
      var data = await load(key);
      Keychain.set(CACHE, JSON.stringify(data));
      widget = render(data, family, false, hidden);
    } catch (error) {
      if (error.message === "key") {
        Keychain.remove(KEY);
        widget = message("La clave ya no sirve. Abre este script en Scriptable y pega otra.");
      } else if (error.message === "offline" && Keychain.contains(CACHE)) {
        widget = render(JSON.parse(Keychain.get(CACHE)), family, true, hidden);
      } else if (error.message === "offline") {
        widget = message("Sin conexión. Se actualiza solo cuando vuelva.");
      } else {
        widget = message("HomeFund no respondió. Se intenta de nuevo en un rato.");
      }
    }
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else if (family === "small") {
    await widget.presentSmall();
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

await main();
`;

// The script with this app's origin in it, so the widget reads and opens the HomeFund it was copied from.
export function widgetScript(siteUrl: string): string {
  return SOURCE.replace("__SITE__", () => JSON.stringify(new URL(siteUrl).origin));
}
