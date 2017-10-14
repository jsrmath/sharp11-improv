var s11 = require('sharp11');
var _ = require('underscore');
var random = require('random-js')();

// Default improv settings
var defaultSettings = {
  dissonance: 0.5, // Likelihood of picking a more dissonant scale
                   // function is i = -2d(ln x), where d = dissonance, number (0 to 1) or range;
                   // x = random number (0 to 1); i = scale index
  changeDir: 0.25, // Likelihood of changing chromatic direction, number (0 to 1) or range
  jumpiness: 0.25, // Likelihood of jumping intervals, number (0 to 1) or range
  rests: [0.35, 0], // Likelihood of a note being a rest (previous note is sustained), number (0 to 1) or range
  rhythmicVariety: [0, 0.75], // Likelihood of rhythmic variety, number (0 to 1) or range
  useSixteenths: true, // Use sixteenth notes
  onlyEighthRests: false, // If true, don't put rests in triplet or sixteenth blocks
  range: ['C4', 'C6'], // Note range
  sections: null, // Which sections to improvise over, null -> song default
  repeat: 1, // How many times to repeat the form
  cadence: true // If true, return to the first chord at the end
};

// Given a chord and a previous traversable scale, return a new traversable scale
var getScale = function (ch, lastNote, settings) {
  var scales = ch.scales();
  var scaleIndex = Math.floor(-2 * settings.dissonance * Math.log(random.real(0, 1)));
  var newScale = scales[scaleIndex % scales.length];
  var dir;

  // If there's no previous scale, start somewhere random
  lastNote = lastNote || s11.note.random(settings.range);

  // Traverse at nearest note, shifting appropriately if out of range
  newScale = newScale.traverse(newScale.nearest(lastNote));

  while (!newScale.current().inRange(settings.range)) {
    dir = newScale.current().lowerThan(settings.range[0]) ? 1 : -1;
    newScale = newScale.shift(dir);
  }

  // Start traversing the new scale from the nearest note to the previous scale's current note
  return newScale;
};

// Given improvisation settings, return a number of notes in for a note group
var getNumNotes = function (settings) {
  if (settings.useSixteenths && random.bool(2 * settings.rhythmicVariety / 3)) {
    return random.bool() ? 3 : 4;
  }

  if (!settings.useSixteenths && random.bool(settings.rhythmicVariety / 2)) {
    return 3;
  }

  return 2;
};

// Given a scale, direction, and improvisation settings
// return a group of a given number of notes and a new direction
var improviseNoteGroup = function (scale, dir, numNotes, settings) {
  var noteGroupObj = {
    notes: [],
    dir: dir
  };

  // True if we are allowed to use rests here
  var useRests = numNotes === 2 || !settings.onlyEighthRests;

  _.times(numNotes, function () {
    var dir = noteGroupObj.dir;

    // Potentially insert rest based on settings
    if (useRests && random.bool(settings.rests)) return noteGroupObj.notes.push(null);

    // Potentially jump to random note based on settings
    if (random.bool(settings.jumpiness)) {
      do {
        scale = scale.random();
      } while (!scale.current().inRange(settings.range));

      noteGroupObj.notes.push(scale.current());
      return noteGroupObj;
    }

    // Potentially change direction based on settings
    if (random.bool(settings.changeDir)) dir = -dir;

    scale = scale.shift(dir);

    // If we're out of bounds, reverse the direction and shift twice
    if (!scale.current().inRange(settings.range)) {
      dir = -dir;
      scale = scale.shift(dir * 2);
    }

    noteGroupObj.notes.push(scale.current());
    noteGroupObj.dir = dir;
  });

  return noteGroupObj;
};

// Return the total number of beats in a chart
var totalBeats = function (chart) {
  return _.reduce(chart, function (total, obj) {
    return total + obj.duration.value();
  }, 0);
};

var ImprovChart = function (chart, settings, data) {
  this.chart = chart;
  this.settings = settings;
  this.data = data;
};

// Return a list of { note, duration }
ImprovChart.prototype.notesAndDurations = function () {
  var noteArr = _.reduce(this.data, function (arr, obj) {
    return arr.concat(obj.notes);
  }, []);

  return _.flatten(_.map(noteArr, function (arr) {
    return _.map(arr, function (note, i) {
      var dur;

      if (arr.length === 2 && i === 0) dur = s11.duration.subunit('longEighth');
      if (arr.length === 2 && i === 1) dur = s11.duration.subunit('shortEighth');
      if (arr.length === 3) dur = s11.duration.subunit('triplet');
      if (arr.length === 4) dur = s11.duration.subunit('sixteenth');

      return { note: note, duration: dur };
    });
  }));
};

// Return a list of { chord, duration }
ImprovChart.prototype.chordsAndDurations = function () {
  return _.map(this.data, _.partial(_.pick, _, 'chord', 'duration'));
};

// Given midi settings, return a Midi object for this improvisation
ImprovChart.prototype.midi = function (settings) {
  return s11.midi.create(settings)
    .addChordTrack(this.chordsAndDurations())
    .addMelodyTrack(this.notesAndDurations());
};

ImprovChart.prototype.toString = function () {
  return this.chart.title() + '\n' + _.map(this.data, function (obj) {
    return '(' + obj.chord.name + ' => ' + obj.scale.name + ') ' + _.map(obj.notes, function (arr) {
      return _.map(arr, function (x) { return x || '_'; }).join(' ');
    }).join(' | ');
  }).join('\n');
};

// Improvise over a chord chart
// Return an object containing an array of objects
// Each object has a chord, a scale, and an array of arrays of notes, each representing one beat
module.exports.overChart = function (chartObj, settings) {
  var originalSettings = _.defaults(settings || {}, defaultSettings);

  // Clone settings because we will modify them to deal with range parameters
  var currentSettings = _.clone(originalSettings);

  // Create section lists based on optional section parameter and repeat setting
  var sections = _.reduce(_.range(currentSettings.repeat), function (sections) {
    return sections.concat(currentSettings.sections || chartObj.sections);
  }, []);

  var chart = chartObj.chart(sections);

  // State we keep track of during improvisation
  var notes = [];
  var lastNote = null;
  var dir = random.pick([-1, 1]);
  var beats = totalBeats(chart);
  var deltas = {}; // An object that keeps track of deltas for currentSettings that change over time

  // If the cadence setting is true, end with the first chord
  if (currentSettings.cadence) {
    chart.push({ chord: _.first(chart).chord, duration: s11.duration.beats(1) });
  }

  // Configure deltas for currentSettings that allow for ranges
  _.each(['dissonance', 'changeDir', 'jumpiness', 'rests', 'rhythmicVariety'], function (setting) {
    if (currentSettings[setting] instanceof Array) {
      deltas[setting] = (currentSettings[setting][1] - currentSettings[setting][0]) / beats;
      currentSettings[setting] = currentSettings[setting][0]; // Start at the first element in the range
    }
    else {
      deltas[setting] = 0;
    }
  });

  // Collect groups of notes
  _.each(chart, function (obj, i) {
    var chord = obj.chord;
    var dur = obj.duration;
    var scale = getScale(chord, lastNote, currentSettings);
    var noteGroupObj = {
      chord: chord,
      scale: scale,
      notes: [],
      duration: dur
    };

    // Collect groups of notes for each beat the chord is being played over
    _.times(dur.beats, function () {
      var noteGroup = improviseNoteGroup(scale, dir, getNumNotes(currentSettings), currentSettings);
      noteGroupObj.notes.push(noteGroup.notes);
      dir = noteGroup.dir;

      lastNote = _.last(_.filter(noteGroup.notes, _.identity));

      // Update scale so that it's on the most recent note
      if (lastNote) scale = scale.withCurrent(lastNote);

      // Update range currentSettings based on deltas
      _.each(deltas, function (delta, setting) {
        currentSettings[setting] += delta;
      });
    });

    // If we're playing a cadence, there should be at most one note in the note group
    if (currentSettings.cadence && i === chart.length - 1) {
      noteGroupObj.notes = [[noteGroupObj.notes[0][0], null]]; // Make it a full beat note group
    }

    notes.push(noteGroupObj);
  });

  return new ImprovChart(chartObj, originalSettings, notes);
};

module.exports.isImprovChart = function (chart) {
  return chart instanceof ImprovChart;
};