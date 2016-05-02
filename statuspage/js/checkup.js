// checkup is the global namespace for all checkup variables (except time).
var checkup = checkup || {};

// time provides simple nanosecond-based unit measurements.
var time = (function() {
	// now gets the current time with millisecond accuracy,
	// but as a unit of nanoseconds.
	var now = function() {
		return new Date().getTime() * 1e6;
	};
	var ns = 1,
		us = 1000 * ns,
		ms = 1000 * us,
		second = 1000 * ms,
		minute = 60 * second,
		hour = 60 * minute,
		day = 24 * hour,
		week = 7 * day;

	return {
		Now: now,
		Nanosecond: ns,
		Microsecond: us,
		Millisecond: ms,
		Second: second,
		Minute: minute,
		Hour: hour,
		Day: day,
		Week: week
	};
})();

// formatDuration formats d (in nanoseconds) with
// a proper unit suffix based on its value.
checkup.formatDuration = function(d) {
	if (d == 0)
		return d+"ms";
	else if (d < time.Millisecond)
		return Math.round(d*1e-3)+"µs";
	else if (d < 10 * time.Second)
		return Math.round(d*1e-6)+"ms";
	else if (d < 90 * time.Second)
		return Math.round(d*1e-9)+"s";
	else if (d < 90 * time.Minute)
		return Math.round(d*1e-9/60)+" minutes";
	else if (d < 48 * time.Hour)
		return Math.round(d*1e-9/60/60)+" hours";
	else
		return Math.round(d*1e-9 / 60/60/24)+" days";
};

// I'm not even joking
checkup.leftpad = function(str, len, ch) {
	str = String(str);
	var i = -1;
	if (!ch && ch !== 0) ch = ' ';
	len = len - str.length;
	while (++i < len) str = ch + str;
	return str;
}

// timeSince renders the duration ms (in milliseconds) in human-friendly form.
checkup.timeSince = function(ms) {
	var seconds = Math.floor((new Date() - ms) / 1000);
	var interval = Math.floor(seconds / 31536000);
	if (interval > 1) return interval + " years";
	interval = Math.floor(seconds / 2592000);
	if (interval > 1) return interval + " months";
	interval = Math.floor(seconds / 86400);
	if (interval > 1) return interval + " days";
	interval = Math.floor(seconds / 3600);
	if (interval > 1) return interval + " hours";
	interval = Math.floor(seconds / 60);
	if (interval > 1) return interval + " minutes";
	return Math.floor(seconds) + " seconds";
};

// makeTimeTag returns a <time> tag (as a string) that
// has the time since the timestamp, ms (in milliseconds).
checkup.makeTimeTag = function(ms) {
	// dateTimeString converts ms (in milliseconds) into
	// a value usable in a <time> tag's datetime attribute.
	function dateTimeString(ms) {
		var d = new Date(ms);
		return d.getFullYear()+"-"
			+ checkup.leftpad(d.getMonth()+1, 2, "0")+"-"
			+ checkup.leftpad(d.getDate(), 2, "0")+"T"
			+ checkup.leftpad(d.getHours(), 2, "0")+":"
			+ checkup.leftpad(d.getMinutes(), 2, "0")+":"
			+ checkup.leftpad(d.getSeconds(), 2, "0")+"-"
			+ checkup.leftpad((d.getTimezoneOffset()/60), 2, "0")+":00";
	}

	return '<time class="dynamic" datetime="'+dateTimeString(ms)+'">'
			+ checkup.timeSince(ms)
			+ '</time>';
}

// All check files must have this suffix.
checkup.checkFileSuffix = "-check.json";

// Width and height of chart viewport scale
checkup.CHART_WIDTH  = 600;
checkup.CHART_HEIGHT = 200;

// A couple bits of state to coordinate rendering the page
checkup.domReady = false;   // whether DOM is loaded
checkup.graphsMade = false; // whether graphs have been rendered at least once
checkup.placeholdersRemoved = false; // whether chart placeholders have been removed

checkup.unixNanoToD3Timestamp = function(unixNanoTimestamp) {
	return new Date(unixNanoTimestamp * 1e-6);
};

// TODO: replace class color names with status names so we don't have to map like this?
// Maps status names to their associated color class.
checkup.color = {healthy: "green", degraded: "yellow", down: "red"};

// Stores the checks that are downloaded (1:1 ratio with check files)
checkup.checks = [];

// Stores all the results, keyed by endpoint
checkup.results = {};

// Stores all the results, keyed by timestamp indicated in the JSON
// of the check file (may be multiple results with same timestamp)
checkup.groupedResults = {};

// Stores the results in ascending timestamp order; order may not be
// guaranteed until all results are loaded
checkup.orderedResults = [];

// Stores the charts (keyed by endpoint) and all their data/info/elements
checkup.charts = {};

// ID counter for the charts, always incremented
checkup.chartCounter = 0;

// Events that get rendered to the timeline
checkup.events = [];

// Duration of chart animations in ms
checkup.animDuration = 150;

// Quick, reusable access to DOM elements; populated after DOM loads
checkup.dom = {};

// Timestamp of the last check, as a Date() object.
checkup.lastCheck = null;

checkup.makeChart = function(title) {
	var chart = {
		id: "chart"+(checkup.chartCounter++),
		title: title,
		results: [],
		series: {
			min: [],
			med: [],
			max: [],
			threshold: [],
			events: [],
		}
	};

	// layered in order they appear here (last series appears on top)
	chart.data = [chart.series.min, chart.series.med];

	return chart;
}

// getJSON downloads the file at url and executes callback
// with the parsed JSON and the url as arguments.
checkup.getJSON = function(url, callback) {
	var request = new XMLHttpRequest();
	request.open('GET', url, true);
	request.onload = function() {
		if (request.status >= 200 && request.status < 400) {
			var json = JSON.parse(request.responseText);
			callback(json, url);
		} else {
			console.error("GET "+url+":", request);
		}
	};
	request.onerror = function() {
		console.error("Network error (GET "+url+"):", request.error);
	};
	request.send();
};

checkup.loadScript = function(url, callback) {
	var head = document.getElementsByTagName("head")[0];
	var script = document.createElement("script");
	script.type = "text/javascript";
	script.src = url;

	script.onreadystatechange = callback;
	script.onload = callback;
	
	head.appendChild(script);
};

// computeStats computes basic stats about a result.
checkup.computeStats = function(result) {
	function median(values) {
		values.sort(function(a, b) { return a.rtt - b.rtt; });
		var half = Math.floor(values.length / 2);
		if (values.length % 2 == 0)
			return Math.round((values[half-1].rtt + values[half].rtt) / 2);
		else
			return values[half].rtt;
	}
	var sum = 0, min, max;
	for (var i = 0; i < result.times.length; i++) {
		var attempt = result.times[i];
		if (!attempt.rtt) continue;
		sum += attempt.rtt;
		if (attempt.rtt < min || (typeof min === 'undefined'))
			min = attempt.rtt;
		if (attempt.rtt > max || (typeof max === 'undefined'))
			max = attempt.rtt;
	}
	return {
		total: sum,
		average: sum / result.times.length,
		median: median(result.times),
		min: min,
		max: max
	};
};
