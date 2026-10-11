// 🚀 Tracelight started automatically on this file.
// 👀 Explore the code below to see the features in action.
// 🧪 Change anything and watch the values update as you type.

// ----- 📝 LOGGING -----

// console.log() output appears right next to your code
import os from 'node:os';
const tracelight = { isAwesome: true, node: process.version };

console.log(tracelight);

// See the value of a variable simply by typing its name
tracelight;

// Use logpoints (F9) or the special comment  // ?  to inspect expressions
// without changing the code
const workingDir = process.cwd();

os.cpus().length; // ?

// Measure how long an expression takes with  // ?.
Array.from({ length: 10_000 }, (_, i) => i * i).reduce((a, b) => a + b, 0); // ?.

// ----- 📊 COVERAGE -----

// Gutter squares show what ran: green = executed, gray = never executed,
// yellow = only part of the line executed (short-circuit / ternary)
console.log('partial', false && true);

if (false) {
  console.log('noCoverage', true);
}

// ----- 🪲 TIME MACHINE -----

// Press Shift+F5 (or the Time Machine button in the Tracelight panel) on any
// line, then step forward and *backward* with F10 / Ctrl+F10, F11 / Ctrl+F11.

class Point {
  constructor(public x: number, public y: number) {}

  distance(other: Point): number {
    const dx = this.x - other.x;
    const dy = this.y - other.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  move(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
  }
}

class Rectangle {
  constructor(public width: number, public height: number, public position: Point) {}

  area(): number {
    return this.width * this.height;
  }

  contains(point: Point): boolean {
    const withinX = this.position.x <= point.x && point.x <= this.position.x + this.width;
    const withinY = this.position.y <= point.y && point.y <= this.position.y + this.height;
    return withinX && withinY;
  }
}

function generateRandomPoint(maxX: number, maxY: number): Point {
  const x = Math.floor(Math.random() * maxX);
  const y = Math.floor(Math.random() * maxY);
  return new Point(x, y);
}

function rectanglesOverlap(r1: Rectangle, r2: Rectangle): boolean {
  const overlapX = r1.position.x < r2.position.x + r2.width && r1.position.x + r1.width > r2.position.x;
  const overlapY = r1.position.y < r2.position.y + r2.height && r1.position.y + r1.height > r2.position.y;
  return overlapX && overlapY;
}

const pointA = new Point(5, 10);
const pointB = generateRandomPoint(100, 100);

const rect1 = new Rectangle(50, 20, new Point(10, 10));
const rect2 = new Rectangle(30, 30, new Point(40, 15));

console.log({ msg: `Do rectangles overlap? ${rectanglesOverlap(rect1, rect2)}`, rect1, rect2 });
console.log({ msg: `Is pointA inside rect1? ${rect1.contains(pointA)}`, rect1, pointA });
console.log({ msg: `Distance between A and B: ${pointA.distance(pointB)}`, pointA, pointB });

// ----- 🔁 VALUES AS OF THIS STEP -----

// With the Time Machine on, inline values and hovers show what a value was at the
// current step, not at the end of the run: step through this loop with F10 and
// watch `total` grow one iteration at a time.
let total = 0;
for (let n = 1; n < 4; n++) {
  total += n;
}

// ----- 🚨 ERRORS -----

// A red square marks the line that raised, pink squares mark the stack path,
// and the message is shown beside the error
throw new Error('Kaboom! This is just a test error.');
