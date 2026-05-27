// ============================================================
// src/lib/i18n.js — Kiosk-facing internationalisation (v5.5.18)
// ============================================================
// Lightweight translator with no external deps. Language is held
// in module state, persisted to localStorage, and React components
// subscribe via the useKioskLang() hook to re-render on change.
//
// Strings live in a single STRINGS map keyed by language code.
// English is fully populated; other languages currently fall back
// to English silently. Add translations incrementally.
//
// Today only ScreenOrderType + ScreenLanguagePicker use t(); other
// kiosk screens can be migrated screen-by-screen.
// ============================================================

import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'rpos-kiosk-lang';
const DEFAULT_LANG = 'en';

// Languages we expose in the picker. Add codes here when more
// translations are populated.
export const LANGUAGES = [
  { code: 'en', name: 'English',  nativeName: 'English',    flag: '🇬🇧' },
  { code: 'es', name: 'Spanish',  nativeName: 'Español',    flag: '🇪🇸' },
  { code: 'fr', name: 'French',   nativeName: 'Français',   flag: '🇫🇷' },
  { code: 'de', name: 'German',   nativeName: 'Deutsch',    flag: '🇩🇪' },
  { code: 'it', name: 'Italian',  nativeName: 'Italiano',   flag: '🇮🇹' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
];

// Translation strings. Nested with dot-keys for clarity:
//   t('orderType.title') etc.
//
// Untranslated keys fall back to English. Missing English keys
// fall back to the raw key (loud + obvious so we notice).
const STRINGS = {
  en: {
    'orderType.title': 'Where will you be eating today?',
    'orderType.eatIn': 'Eat in',
    'orderType.eatIn.subtitle': 'Served to your table',
    'orderType.takeaway': 'Take away',
    'orderType.takeaway.subtitle': 'Collect at the counter',
    'orderType.loyaltySignIn': 'Sign in for rewards',
    'tableNumber.title': 'Enter your table number',
    'tableNumber.placeholder': 'Table number',
    'tableNumber.delete': 'Delete',
    'tableNumber.continue': 'Continue',
    'menu.add': 'Add',
    'menu.currentOrder': 'Current order',
    'menu.goToCheckout': 'Go to checkout',
    'menu.itemSingular': 'item',
    'menu.itemPlural': 'items',
    'menu.empty': 'No items in this category.',
    'menu.noCategories': 'No categories on this menu yet.',
    'menu.allergens.tap': 'Have allergies? Tap to filter the menu',
    'menu.allergens.avoiding': 'Avoiding',
    'menu.allergens.unsafeFaded': 'unsafe items shown faded',
    'menu.allergens.haveAllergies': 'Have allergies?',
    'menu.allergens.tapToFilter': 'Tap to filter the menu',
    'menu.allergens.editFilter': 'Edit',
    'cart.title.pickup': 'Pick up order',
    'cart.title.dineIn': 'Dine-in order',
    'cart.viewAllergens': 'View Allergens',
    'cart.empty': 'Your cart is empty',
    'cart.addMore': '+ Add more items',
    'cart.itemsTotal': 'Items total',
    'cart.totalToPay': 'Total to pay',
    'cart.removeLine': 'Remove',
    'details.title': 'Enter your name',
    'details.subtitle': 'Enter your name below and we will call you when your order is ready',
    'details.name.label': 'Your name',
    'details.name.placeholder': 'Name',
    'details.mobile.label': 'Your mobile',
    'details.mobile.placeholder': 'Mobile number',
    'details.optional': 'Optional - for your receipt',
    'details.email.label': 'Your email',
    'details.email.placeholder': 'Email',
    'details.continue': 'Continue',
    'details.optIn': 'Opt-in to receive updates, offers and promotions via email',
    'details.skip': 'Skip',
    'details.welcome': 'Welcome back',
    'details.lookupChecking': 'Checking your details…',
    'product.allergens': 'Allergens',
    'product.selectOptions': 'Select options',
    'product.required': 'Required',
    'product.optional': 'Optional',
    'product.pickOne': 'pick one',
    'product.pick': 'pick',
    'product.upTo': 'up to',
    'product.anythingElse': 'Anything else?',
    'product.anythingElse.placeholder': 'e.g. no ice, light sauce, allergy notes…',
    'product.addToOrder': 'Add to order',
    'product.loading': 'Loading…',
    'language.choose': 'Choose your language',
    'language.close': 'Close',
    'common.back': 'Back',
  },
  es: {
    'orderType.title': '¿Dónde vas a comer hoy?',
    'orderType.eatIn': 'Comer aquí',
    'orderType.eatIn.subtitle': 'Servido en tu mesa',
    'orderType.takeaway': 'Para llevar',
    'orderType.takeaway.subtitle': 'Recoger en el mostrador',
    'orderType.loyaltySignIn': 'Inicia sesión para recompensas',
    'tableNumber.title': 'Introduce el número de tu mesa',
    'tableNumber.placeholder': 'Número de mesa',
    'tableNumber.delete': 'Borrar',
    'tableNumber.continue': 'Continuar',
    'menu.add': 'Añadir',
    'menu.currentOrder': 'Pedido actual',
    'menu.goToCheckout': 'Ir al pago',
    'menu.itemSingular': 'artículo',
    'menu.itemPlural': 'artículos',
    'menu.empty': 'No hay artículos en esta categoría.',
    'menu.noCategories': 'Aún no hay categorías en este menú.',
    'menu.allergens.tap': '¿Tienes alergias? Toca para filtrar el menú',
    'menu.allergens.avoiding': 'Evitando',
    'menu.allergens.unsafeFaded': 'los artículos no seguros se muestran atenuados',
    'menu.allergens.haveAllergies': '¿Tienes alergias?',
    'menu.allergens.tapToFilter': 'Toca para filtrar el menú',
    'menu.allergens.editFilter': 'Editar',
    'cart.title.pickup': 'Pedido para llevar',
    'cart.title.dineIn': 'Pedido en mesa',
    'cart.viewAllergens': 'Ver alérgenos',
    'cart.empty': 'Tu carrito está vacío',
    'cart.addMore': '+ Añadir más artículos',
    'cart.itemsTotal': 'Total de artículos',
    'cart.totalToPay': 'Total a pagar',
    'cart.removeLine': 'Eliminar',
    'details.title': 'Introduce tu nombre',
    'details.subtitle': 'Introduce tu nombre y te llamaremos cuando tu pedido esté listo',
    'details.name.label': 'Tu nombre',
    'details.name.placeholder': 'Nombre',
    'details.mobile.label': 'Tu móvil',
    'details.mobile.placeholder': 'Número de móvil',
    'details.optional': 'Opcional - para tu recibo',
    'details.email.label': 'Tu email',
    'details.email.placeholder': 'Email',
    'details.continue': 'Continuar',
    'details.optIn': 'Acepto recibir actualizaciones, ofertas y promociones por email',
    'details.skip': 'Omitir',
    'details.welcome': 'Bienvenido de nuevo',
    'details.lookupChecking': 'Comprobando tus datos…',
    'product.allergens': 'Alérgenos',
    'product.selectOptions': 'Selecciona opciones',
    'product.required': 'Obligatorio',
    'product.optional': 'Opcional',
    'product.pickOne': 'elige uno',
    'product.pick': 'elige',
    'product.upTo': 'hasta',
    'product.anythingElse': '¿Algo más?',
    'product.anythingElse.placeholder': 'p. ej. sin hielo, salsa ligera, notas de alergia…',
    'product.addToOrder': 'Añadir al pedido',
    'product.loading': 'Cargando…',
    'language.choose': 'Elige tu idioma',
    'language.close': 'Cerrar',
    'common.back': 'Atrás',
  },
  fr: {
    'orderType.title': 'Où allez-vous manger aujourd\u2019hui ?',
    'orderType.eatIn': 'Sur place',
    'orderType.eatIn.subtitle': 'Servi à votre table',
    'orderType.takeaway': 'À emporter',
    'orderType.takeaway.subtitle': 'À récupérer au comptoir',
    'orderType.loyaltySignIn': 'Connectez-vous pour vos récompenses',
    'tableNumber.title': 'Entrez votre numéro de table',
    'tableNumber.placeholder': 'Numéro de table',
    'tableNumber.delete': 'Effacer',
    'tableNumber.continue': 'Continuer',
    'menu.add': 'Ajouter',
    'menu.currentOrder': 'Commande en cours',
    'menu.goToCheckout': 'Passer au paiement',
    'menu.itemSingular': 'article',
    'menu.itemPlural': 'articles',
    'menu.empty': 'Aucun article dans cette catégorie.',
    'menu.noCategories': 'Aucune catégorie sur ce menu pour le moment.',
    'menu.allergens.tap': 'Des allergies ? Touchez pour filtrer le menu',
    'menu.allergens.avoiding': 'Éviter',
    'menu.allergens.unsafeFaded': 'les articles non sûrs sont atténués',
    'menu.allergens.haveAllergies': 'Des allergies ?',
    'menu.allergens.tapToFilter': 'Touchez pour filtrer le menu',
    'menu.allergens.editFilter': 'Modifier',
    'cart.title.pickup': 'Commande à emporter',
    'cart.title.dineIn': 'Commande sur place',
    'cart.viewAllergens': 'Voir les allergènes',
    'cart.empty': 'Votre panier est vide',
    'cart.addMore': '+ Ajouter d\u2019autres articles',
    'cart.itemsTotal': 'Total des articles',
    'cart.totalToPay': 'Total à payer',
    'cart.removeLine': 'Supprimer',
    'details.title': 'Entrez votre nom',
    'details.subtitle': 'Entrez votre nom et nous vous appellerons quand votre commande sera prête',
    'details.name.label': 'Votre nom',
    'details.name.placeholder': 'Nom',
    'details.mobile.label': 'Votre mobile',
    'details.mobile.placeholder': 'Numéro de mobile',
    'details.optional': 'Facultatif - pour votre reçu',
    'details.email.label': 'Votre email',
    'details.email.placeholder': 'Email',
    'details.continue': 'Continuer',
    'details.optIn': 'J\u2019accepte de recevoir des actualités, offres et promotions par email',
    'details.skip': 'Passer',
    'details.welcome': 'Bon retour',
    'details.lookupChecking': 'Vérification de vos informations…',
    'product.allergens': 'Allergènes',
    'product.selectOptions': 'Choisissez vos options',
    'product.required': 'Obligatoire',
    'product.optional': 'Facultatif',
    'product.pickOne': 'choisir un',
    'product.pick': 'choisir',
    'product.upTo': 'jusqu\u2019à',
    'product.anythingElse': 'Autre chose ?',
    'product.anythingElse.placeholder': 'ex. sans glace, sauce légère, notes d\u2019allergie…',
    'product.addToOrder': 'Ajouter à la commande',
    'product.loading': 'Chargement…',
    'language.choose': 'Choisissez votre langue',
    'language.close': 'Fermer',
    'common.back': 'Retour',
  },
  de: {
    'orderType.title': 'Wo werden Sie heute essen?',
    'orderType.eatIn': 'Hier essen',
    'orderType.eatIn.subtitle': 'An Ihren Tisch serviert',
    'orderType.takeaway': 'Zum Mitnehmen',
    'orderType.takeaway.subtitle': 'An der Theke abholen',
    'orderType.loyaltySignIn': 'Anmelden für Prämien',
    'tableNumber.title': 'Geben Sie Ihre Tischnummer ein',
    'tableNumber.placeholder': 'Tischnummer',
    'tableNumber.delete': 'Löschen',
    'tableNumber.continue': 'Weiter',
    'menu.add': 'Hinzufügen',
    'menu.currentOrder': 'Aktuelle Bestellung',
    'menu.goToCheckout': 'Zur Kasse',
    'menu.itemSingular': 'Artikel',
    'menu.itemPlural': 'Artikel',
    'menu.empty': 'Keine Artikel in dieser Kategorie.',
    'menu.noCategories': 'Noch keine Kategorien in diesem Menü.',
    'menu.allergens.tap': 'Allergien? Tippen Sie, um das Menü zu filtern',
    'menu.allergens.avoiding': 'Vermeiden',
    'menu.allergens.unsafeFaded': 'unsichere Artikel werden ausgeblendet',
    'menu.allergens.haveAllergies': 'Allergien?',
    'menu.allergens.tapToFilter': 'Tippen, um das Menü zu filtern',
    'menu.allergens.editFilter': 'Bearbeiten',
    'cart.title.pickup': 'Bestellung zum Mitnehmen',
    'cart.title.dineIn': 'Bestellung im Lokal',
    'cart.viewAllergens': 'Allergene anzeigen',
    'cart.empty': 'Ihr Warenkorb ist leer',
    'cart.addMore': '+ Weitere Artikel hinzufügen',
    'cart.itemsTotal': 'Artikel gesamt',
    'cart.totalToPay': 'Zu zahlen',
    'cart.removeLine': 'Entfernen',
    'details.title': 'Geben Sie Ihren Namen ein',
    'details.subtitle': 'Geben Sie Ihren Namen ein und wir rufen Sie, wenn Ihre Bestellung fertig ist',
    'details.name.label': 'Ihr Name',
    'details.name.placeholder': 'Name',
    'details.mobile.label': 'Ihre Mobilnummer',
    'details.mobile.placeholder': 'Mobilnummer',
    'details.optional': 'Optional - für Ihre Quittung',
    'details.email.label': 'Ihre E-Mail',
    'details.email.placeholder': 'E-Mail',
    'details.continue': 'Weiter',
    'details.optIn': 'Updates, Angebote und Aktionen per E-Mail erhalten',
    'details.skip': 'Überspringen',
    'details.welcome': 'Willkommen zurück',
    'details.lookupChecking': 'Daten werden geprüft…',
    'product.allergens': 'Allergene',
    'product.selectOptions': 'Optionen auswählen',
    'product.required': 'Erforderlich',
    'product.optional': 'Optional',
    'product.pickOne': 'eine wählen',
    'product.pick': 'wählen',
    'product.upTo': 'bis zu',
    'product.anythingElse': 'Sonst noch etwas?',
    'product.anythingElse.placeholder': 'z. B. ohne Eis, leichte Soße, Allergiehinweise…',
    'product.addToOrder': 'Zur Bestellung hinzufügen',
    'product.loading': 'Lädt…',
    'language.choose': 'Wählen Sie Ihre Sprache',
    'language.close': 'Schließen',
    'common.back': 'Zurück',
  },
  it: {
    'orderType.title': 'Dove mangerai oggi?',
    'orderType.eatIn': 'Mangia qui',
    'orderType.eatIn.subtitle': 'Servito al tuo tavolo',
    'orderType.takeaway': 'Da asporto',
    'orderType.takeaway.subtitle': 'Ritira al banco',
    'orderType.loyaltySignIn': 'Accedi per i premi',
    'tableNumber.title': 'Inserisci il numero del tuo tavolo',
    'tableNumber.placeholder': 'Numero del tavolo',
    'tableNumber.delete': 'Elimina',
    'tableNumber.continue': 'Continua',
    'menu.add': 'Aggiungi',
    'menu.currentOrder': 'Ordine attuale',
    'menu.goToCheckout': 'Vai al pagamento',
    'menu.itemSingular': 'articolo',
    'menu.itemPlural': 'articoli',
    'menu.empty': 'Nessun articolo in questa categoria.',
    'menu.noCategories': 'Ancora nessuna categoria in questo menu.',
    'menu.allergens.tap': 'Hai allergie? Tocca per filtrare il menu',
    'menu.allergens.avoiding': 'Evitando',
    'menu.allergens.unsafeFaded': 'gli articoli non sicuri sono attenuati',
    'menu.allergens.haveAllergies': 'Hai allergie?',
    'menu.allergens.tapToFilter': 'Tocca per filtrare il menu',
    'menu.allergens.editFilter': 'Modifica',
    'cart.title.pickup': 'Ordine da asporto',
    'cart.title.dineIn': 'Ordine al tavolo',
    'cart.viewAllergens': 'Vedi allergeni',
    'cart.empty': 'Il tuo carrello è vuoto',
    'cart.addMore': '+ Aggiungi altri articoli',
    'cart.itemsTotal': 'Totale articoli',
    'cart.totalToPay': 'Totale da pagare',
    'cart.removeLine': 'Rimuovi',
    'details.title': 'Inserisci il tuo nome',
    'details.subtitle': 'Inserisci il tuo nome qui sotto e ti chiameremo quando il tuo ordine sarà pronto',
    'details.name.label': 'Il tuo nome',
    'details.name.placeholder': 'Nome',
    'details.mobile.label': 'Il tuo cellulare',
    'details.mobile.placeholder': 'Numero di cellulare',
    'details.optional': 'Opzionale - per la tua ricevuta',
    'details.email.label': 'La tua email',
    'details.email.placeholder': 'Email',
    'details.continue': 'Continua',
    'details.optIn': 'Iscriviti per ricevere aggiornamenti, offerte e promozioni via email',
    'details.skip': 'Salta',
    'details.welcome': 'Bentornato',
    'details.lookupChecking': 'Controllo dei tuoi dati…',
    'product.allergens': 'Allergeni',
    'product.selectOptions': 'Seleziona le opzioni',
    'product.required': 'Obbligatorio',
    'product.optional': 'Opzionale',
    'product.pickOne': 'scegline uno',
    'product.pick': 'scegli',
    'product.upTo': 'fino a',
    'product.anythingElse': 'Altro?',
    'product.anythingElse.placeholder': 'es. niente ghiaccio, salsa leggera, note allergie…',
    'product.addToOrder': 'Aggiungi all\u2019ordine',
    'product.loading': 'Caricamento…',
    'language.choose': 'Scegli la tua lingua',
    'language.close': 'Chiudi',
    'common.back': 'Indietro',
  },
  pt: {
    'orderType.title': 'Onde vai comer hoje?',
    'orderType.eatIn': 'Comer aqui',
    'orderType.eatIn.subtitle': 'Servido à sua mesa',
    'orderType.takeaway': 'Para levar',
    'orderType.takeaway.subtitle': 'Recolher ao balcão',
    'orderType.loyaltySignIn': 'Entrar para recompensas',
    'tableNumber.title': 'Insira o número da sua mesa',
    'tableNumber.placeholder': 'Número da mesa',
    'tableNumber.delete': 'Apagar',
    'tableNumber.continue': 'Continuar',
    'menu.add': 'Adicionar',
    'menu.currentOrder': 'Pedido atual',
    'menu.goToCheckout': 'Ir para pagamento',
    'menu.itemSingular': 'item',
    'menu.itemPlural': 'itens',
    'menu.empty': 'Sem artigos nesta categoria.',
    'menu.noCategories': 'Ainda não há categorias neste menu.',
    'menu.allergens.tap': 'Tem alergias? Toque para filtrar o menu',
    'menu.allergens.avoiding': 'A evitar',
    'menu.allergens.unsafeFaded': 'artigos inseguros aparecem esbatidos',
    'menu.allergens.haveAllergies': 'Tem alergias?',
    'menu.allergens.tapToFilter': 'Toque para filtrar o menu',
    'menu.allergens.editFilter': 'Editar',
    'cart.title.pickup': 'Pedido para levar',
    'cart.title.dineIn': 'Pedido na mesa',
    'cart.viewAllergens': 'Ver alergénios',
    'cart.empty': 'O seu carrinho está vazio',
    'cart.addMore': '+ Adicionar mais artigos',
    'cart.itemsTotal': 'Total de artigos',
    'cart.totalToPay': 'Total a pagar',
    'cart.removeLine': 'Remover',
    'details.title': 'Insira o seu nome',
    'details.subtitle': 'Insira o seu nome abaixo e iremos chamá-lo quando o pedido estiver pronto',
    'details.name.label': 'O seu nome',
    'details.name.placeholder': 'Nome',
    'details.mobile.label': 'O seu telemóvel',
    'details.mobile.placeholder': 'Número de telemóvel',
    'details.optional': 'Opcional - para o seu recibo',
    'details.email.label': 'O seu email',
    'details.email.placeholder': 'Email',
    'details.continue': 'Continuar',
    'details.optIn': 'Aceitar receber atualizações, ofertas e promoções por email',
    'details.skip': 'Saltar',
    'details.welcome': 'Bem-vindo de volta',
    'details.lookupChecking': 'A verificar os seus dados…',
    'product.allergens': 'Alergénios',
    'product.selectOptions': 'Selecione as opções',
    'product.required': 'Obrigatório',
    'product.optional': 'Opcional',
    'product.pickOne': 'escolher um',
    'product.pick': 'escolher',
    'product.upTo': 'até',
    'product.anythingElse': 'Mais alguma coisa?',
    'product.anythingElse.placeholder': 'ex. sem gelo, molho leve, notas de alergia…',
    'product.addToOrder': 'Adicionar ao pedido',
    'product.loading': 'A carregar…',
    'language.choose': 'Escolha o seu idioma',
    'language.close': 'Fechar',
    'common.back': 'Voltar',
  },
};

// ----- module state + subscribers -----
let _lang = (() => {
  try {
    const stored = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY);
    if (stored && STRINGS[stored]) return stored;
  } catch { /* localStorage may be blocked */ }
  return DEFAULT_LANG;
})();

const _subs = new Set();

export function getLang() {
  return _lang;
}

export function setLang(code) {
  if (!STRINGS[code]) {
    console.warn('[i18n] unknown language code, ignoring:', code);
    return;
  }
  if (code === _lang) return;
  _lang = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* noop */ }
  _subs.forEach(fn => { try { fn(); } catch (e) { console.error('[i18n] subscriber threw', e); } });
}

export function t(key, lang) {
  const useLang = lang || _lang;
  const langDict = STRINGS[useLang] || STRINGS[DEFAULT_LANG];
  if (langDict && langDict[key] != null) return langDict[key];
  // Fall back to English
  const enDict = STRINGS[DEFAULT_LANG] || {};
  if (enDict[key] != null) return enDict[key];
  // Loud fallback: return raw key so missing strings are visible
  return key;
}

export function getLanguageMeta(code) {
  return LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
}

// ----- React hook -----
// Causes the calling component to re-render when language changes.
// Uses useSyncExternalStore (the React 18+ idiom for subscribing
// React renders to a non-React store), which sidesteps the
// set-state-in-effect class of warnings + races on mount.
function _subscribe(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}
function _getSnapshot() { return _lang; }
export function useKioskLang() {
  return useSyncExternalStore(_subscribe, _getSnapshot, _getSnapshot);
}
