import assert from "node:assert/strict";
import test from "node:test";

import { distinctMeasureName } from "./measure";

test("a name that is not the unit is kept", () => {
  assert.equal(distinctMeasureName("Minutos hablados", "min", []), "Minutos hablados");
  assert.equal(distinctMeasureName("Práctica", "minutos", []), "Práctica");
});

test("a name that is the unit itself drops", () => {
  assert.equal(distinctMeasureName("km", "km", ["km"]), null);
  assert.equal(distinctMeasureName("  KM ", "km", []), null);
});

test("a name that is a word of the unit drops, singular or plural", () => {
  assert.equal(distinctMeasureName("Páginas", "página", ["página", "páginas"]), null);
  assert.equal(distinctMeasureName("página", "página", ["página", "páginas"]), null);
});

test("a name that is a unit of time drops whatever the unit is", () => {
  assert.equal(distinctMeasureName("minutos", "min", []), null);
  assert.equal(distinctMeasureName("min", "minutos", []), null);
});

test("no name stays no name; the declared line uses the same answer", () => {
  assert.equal(distinctMeasureName(null, "km", ["km"]), null);
  assert.equal(distinctMeasureName("distancia", "km", ["km"]), "distancia");
});

test("an hour word drops on a goal measured in minutes", () => {
  assert.equal(distinctMeasureName("horas", "minutos", []), null);
  assert.equal(distinctMeasureName("h", "min", []), null);
});

test("a trailing dot is not part of the word", () => {
  assert.equal(distinctMeasureName("min.", "minutos", []), null);
  assert.equal(distinctMeasureName("km.", "km", ["km"]), null);
});

test("a name that only starts with a unit word stays named", () => {
  assert.equal(distinctMeasureName("Horas de sueño", "min", []), "Horas de sueño");
  assert.equal(distinctMeasureName("Minutos hablados", "min", []), "Minutos hablados");
});

test("a blank name is no name, so the line never reads «mide  , en km»", () => {
  assert.equal(distinctMeasureName("", "km", ["km"]), null);
  assert.equal(distinctMeasureName("   ", "km", ["km"]), null);
  assert.equal(distinctMeasureName(".", "km", ["km"]), null);
});
