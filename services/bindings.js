/**
 * services/midi/bindings.js
 *
 * Pure MIDI binding helpers — note/CC naming and key-matching. No DOM,
 * no state — extracted so midi.js and learn.js can share this logic
 * without duplicating it.
 */

/** Human-readable label for a MIDI Note-On or Control-Change message. */
export function midiDesc(type, note) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  if (type === 9) return `Note: ${names[note % 12]}${Math.floor(note/12)-1}`;
  if (type === 11) return `CC${note}`;
  return `#${note}`;
}

/** Builds the compact "type:channel:note" key used to compare a live MIDI message against a saved binding. */
export function midiKey(type, channel, note) {
  return `${type}:${channel}:${note}`;
}

/** Whether a live message's key matches a saved binding (or the binding is unset). */
export function matchesBinding(binding, key) {
  return !!(binding && binding.key === key);
}
