// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

export default `/*
  Welcome!

  This is a starter model — edit the code and the preview
  updates as you go.

  A handful of example libraries are bundled in the file
  explorer above (search for "demo" or "example"); you can
  include them directly from your own models.

  Happy modeling!
*/

title = "OpenSCAD";

color("gray")
    rotate([90, 0, 0])
        translate([0, debug ? -60 : -20, 0])
            linear_extrude(1)
                text(title,
                    halign="center",
                    valign="center");

// You can find the original for the following example in the file explorer above,
// under openscad / examples / Basic / CSG-modules.scad

// CSG-modules.scad - Basic usage of modules, if, color, $fs/$fa

// Change this to false to remove the helper geometry
debug = true;

// Global resolution
$fs=$preview ? 1 : 0.1;  // Don't generate smaller facets than 0.1 mm
$fa=$preview ? 15 : 5;    // Don't generate larger angles than 5 degrees

// Main geometry
difference() {
    intersection() {
        body();
        intersector();
    }
    holes();
}

// Helpers
if (debug) helpers();

// Core geometric primitives.
// These can be modified to create variations of the final object

module body() {
    color("Blue") sphere(10);
}

module intersector() {
    color("Red") cube(15, center=true);
}

module holeObject() {
    color("Lime") cylinder(h=20, r=5, center=true);
}

// Various modules for visualizing intermediate components

module intersected() {
    intersection() {
        body();
        intersector();
    }
}

module holeA() rotate([0,90,0]) holeObject();
module holeB() rotate([90,0,0]) holeObject();
module holeC() holeObject();

module holes() {
    union() {
        holeA();
        holeB();
        holeC();
    }
}

module helpers() {
    // Inner module since it's only needed inside helpers
    module line() color("Black") cylinder(r=1, h=10, center=true);

    scale(0.5) {
        translate([-30,0,-40]) {
            intersected();
            translate([-15,0,-35]) body();
            translate([15,0,-35]) intersector();
            translate([-7.5,0,-17.5]) rotate([0,30,0]) line();
            translate([7.5,0,-17.5]) rotate([0,-30,0]) line();
        }
        translate([30,0,-40]) {
            holes();
            translate([-10,0,-35]) holeA();
            translate([10,0,-35]) holeB();
            translate([30,0,-35]) holeC();
            translate([5,0,-17.5]) rotate([0,-20,0]) line();
            translate([-5,0,-17.5]) rotate([0,30,0]) line();
            translate([15,0,-17.5]) rotate([0,-45,0]) line();
        }
        translate([-20,0,-22.5]) rotate([0,45,0]) line();
        translate([20,0,-22.5]) rotate([0,-45,0]) line();
    }
}

echo(version=version());
// Written by Marius Kintel <marius@kintel.net>
//
// To the extent possible under law, the author(s) have dedicated all
// copyright and related and neighboring rights to this software to the
// public domain worldwide. This software is distributed without any
// warranty.
//
// You should have received a copy of the CC0 Public Domain
// Dedication along with this software.
// If not, see <http://creativecommons.org/publicdomain/zero/1.0/>.
`;
