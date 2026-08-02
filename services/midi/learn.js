/**
 * services/midi/learn.js
 *
 * MIDI Learn mode — lets the person press a physical MIDI button/pedal
 * to assign Next/Previous page bindings. Extracted from app.js during
 * the repository restructuring; logic unchanged from the original.
 */
import { state } from '../ui/viewer.js';
import { midiDesc } from './bindings.js';
import { showToast } from '../utils/helpers.js';
import { saveLocalPrefs } from '../utils/storage.js';

export function toggleMidiLearn() {
  if (!state.midiAccess) {
    showToast('MIDI not connected', 'error'); return;
  }
  state.midiLearn = !state.midiLearn;
  const btn = document.getElementById('midi-learn-btn');
  const lbl = document.getElementById('midi-learn-label');
  if (state.midiLearn) {
    // Reset and start fresh
    state.midiNextNote = null;
    state.midiPrevNote = null;
    btn.classList.add('learning');
    lbl.textContent = 'Learning NEXT… press a button';
    showToast('Press the NEXT PAGE button on your controller', 'info');
  } else {
    btn.classList.remove('learning');
    lbl.textContent = 'MIDI Learn: OFF';
  }
  updateMidiMappingInfo();
}

export function clearMidiMapping() {
  state.midiNextNote = null;
  state.midiPrevNote = null;
  state.midiLearn    = false;
  document.getElementById('midi-learn-btn').classList.remove('learning');
  document.getElementById('midi-learn-label').textContent = 'MIDI Learn: OFF';
  updateMidiMappingInfo();
  saveLocalPrefs();
  showToast('MIDI mappings cleared', 'info');
}

export function updateMidiMappingInfo() {
  document.getElementById('midi-next-map').textContent =
    state.midiNextNote ? midiDesc(state.midiNextNote.type, state.midiNextNote.note) : 'Not assigned';
  document.getElementById('midi-prev-map').textContent =
    state.midiPrevNote ? midiDesc(state.midiPrevNote.type, state.midiPrevNote.note) : 'Not assigned';
}
