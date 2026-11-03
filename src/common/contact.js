'use strict';

/**
 * Contact details in free text: phones, long numbers, emails and links. M11 refuses them in messages
 * before payment; M26 refuses them in public tournament posts and comments.
 */
const PHONE = /(\+?88)?0?1[3-9](?:[\s.-]?\d){8}/;
const DIGITS = /(?:\d[\s.-]?){9,}/;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LINK = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|bd|me|io|co)\b/i;

const hasContact = (text) => PHONE.test(text) || DIGITS.test(text) || EMAIL.test(text) || LINK.test(text);

module.exports = { hasContact };
