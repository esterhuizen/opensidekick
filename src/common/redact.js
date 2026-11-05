// Workflows recorded before 0.6.1 kept what was typed into card and code fields.
// Leave those values out of the prompt; the user fills such fields themselves.
// A value is dropped when it looks like a card number (13-19 digits passing
// the Luhn check) or when the field's name has a secret word in it.
const OLD_TYPE_STEP_RE = /^Type "([\s\S]*)" into the ([\s\S]*) field$/;
const SECRET_FIELD_WORD_RE = /\b(card|cvv2?|cvc2?|csc|security (code|answer)|pin|otp|2fa|one.?time|passcode|password|passwort|passwd|pwd|kennwort|mot de passe|kartennummer|verification|sms code|auth(entication)? code|expir\w*|ccnum\w*|cc.?number)\b|mm ?\/ ?yy/i;
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
export function redactStep(text) {
  const m = OLD_TYPE_STEP_RE.exec(text);
  if (!m) return text;
  const digits = m[1].replace(/[\s-]/g, "");
  const cardLike = /^\d{13,19}$/.test(digits) && luhn(digits);
  const split = m[2].replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ");
  return cardLike || SECRET_FIELD_WORD_RE.test(m[2]) || SECRET_FIELD_WORD_RE.test(split) ? `Fill in the ${m[2]} field yourself (a secret value is not replayed)` : text;
}
