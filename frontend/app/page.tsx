"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

type Stop = {
  name: string;
  lat: number;
  lng: number;
};

type Ticket = {
  id: string;
  ticketId?: string;
  bus?: string;
  route?: string;
  destination?: string;
  status?: string;
  createdAt?: unknown;
  bellTriggeredAt?: unknown;
  bellTriggerLocation?: { lat: number; lng: number };
};

const buses = ["MH-09-1234", "MH-09-5678", "MH-09-9012"];

const routes: Record<string, string[]> = {
  "Kolhapur City Route": [
    "CBS",
    "Shivaji Chowk",
    "Rankala",
    "Kolhapur Railway Station",
  ],
  "Central Route": [
    "CBS",
    "Shivaji Chowk",
    "Kolhapur Railway Station",
  ],
};

const stops: Stop[] = [
  { name: "CBS", lat: 16.705, lng: 74.2433 },
  { name: "Shivaji Chowk", lat: 16.7047, lng: 74.2438 },
  { name: "Rankala", lat: 16.6948, lng: 74.2228 },
  { name: "Kolhapur Railway Station", lat: 16.7034, lng: 74.2407 },
];

const GEOFENCE_KM = 0.03;

function distanceKm(
  a: { lat: number; lng: number },
  b: Stop
) {
  const R = 6371;

  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;

  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 *
      Math.cos(lat1) *
      Math.cos(lat2);

  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function playBell() {
  if (typeof window === "undefined") return;

  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;

    if (!AudioContextClass) return;

    const context = new AudioContextClass();

    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = "sine";

    oscillator.frequency.setValueAtTime(
      880,
      context.currentTime
    );

    oscillator.frequency.setValueAtTime(
      660,
      context.currentTime + 0.25
    );

    gain.gain.setValueAtTime(
      0.0001,
      context.currentTime
    );

    gain.gain.exponentialRampToValueAtTime(
      0.25,
      context.currentTime + 0.02
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      context.currentTime + 0.9
    );

    oscillator.connect(gain);
    gain.connect(context.destination);

    oscillator.start();
    oscillator.stop(context.currentTime + 0.9);
  } catch (error) {
    console.error("Bell audio error:", error);
  }
}

export default function Home() {
  const [bus, setBus] = useState("");
  const [route, setRoute] = useState(
    "Kolhapur City Route"
  );
  const [destination, setDestination] = useState("");
  const [ticket, setTicket] = useState("");
  const [generatedTicket, setGeneratedTicket] = useState<{
    ticketId: string;
    bus: string;
    route: string;
    destination: string;
    status: string;
    createdAt: Date;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);

  const [currentLocation, setCurrentLocation] = useState({
    lat: 16.705,
    lng: 74.2433,
  });

  const [simulationStep, setSimulationStep] = useState(0);
  const [simulationRunning, setSimulationRunning] =
    useState(false);

  const [gpsMode, setGpsMode] = useState<
    "simulator" | "real"
  >("simulator");

  const [bellStatus, setBellStatus] =
    useState("Monitoring");

  const [lastBell, setLastBell] = useState("");

  const [gpsError, setGpsError] = useState("");
  const [validationError, setValidationError] = useState("");

  const bellTriggeredRef = useRef(false);
  const isSavingRef = useRef(false);
  const lastSyncRef = useRef(0);

  useEffect(() => {
    const ticketsQuery = query(
      collection(db, "tickets"),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      ticketsQuery,
      (snapshot) => {
        const ticketList = snapshot.docs.map((item) => ({
          id: item.id,
          ...item.data(),
        })) as Ticket[];

        setTickets(ticketList);
      },
      (error) => {
        console.error("Ticket fetch error:", error);
      }
    );

    return () => unsubscribe();
  }, []);

  const routeStops = useMemo(
    () =>
      routes[route] ??
      stops.map((item) => item.name),
    [route]
  );

  const availableDestinations = useMemo(
    () =>
      stops.filter((stop) =>
        routeStops.includes(stop.name)
      ),
    [routeStops]
  );

  const targetStop = stops.find(
    (stop) => stop.name === destination
  );

  const distanceToDestination = targetStop
    ? distanceKm(currentLocation, targetStop)
    : null;

  const nearestStop = stops.reduce(
    (nearest, stop) => {
      const distance = distanceKm(
        currentLocation,
        stop
      );

      return distance < nearest.distance
        ? { stop, distance }
        : nearest;
    },
    {
      stop: stops[0],
      distance: Number.POSITIVE_INFINITY,
    }
  );

  const activeTickets = tickets.filter(
    (item) => item.status !== "completed"
  );

  const completedTickets = tickets.filter(
    (item) => item.status === "completed"
  );

  const destinationReached =
    distanceToDestination !== null &&
    distanceToDestination <= GEOFENCE_KM;

  const generateTicket = async () => {
    if (isSavingRef.current) return;

    if (!bus || !route || !destination) {
      setValidationError("Please select Bus, Route, and Destination to generate a ticket.");
      return;
    }

    setValidationError("");

    try {
      isSavingRef.current = true;
      setSaving(true);

      const ticketId = `TKT${Date.now()
        .toString()
        .slice(-5)}`;

      await addDoc(collection(db, "tickets"), {
        ticketId,
        bus,
        route,
        destination,
        status: "monitoring",
        createdAt: serverTimestamp(),
      });

      setTicket(ticketId);
      setGeneratedTicket({
        ticketId,
        bus,
        route,
        destination,
        status: "monitoring",
        createdAt: new Date(),
      });

      bellTriggeredRef.current = false;
      setBellStatus("Monitoring");
    } catch (error) {
      console.error("Ticket save error:", error);
      setValidationError("Failed to save ticket. Please try again.");
    } finally {
      isSavingRef.current = false;
      setSaving(false);
    }
  };

  const triggerBell = async () => {
    if (!ticket || bellTriggeredRef.current) return;

    playBell();

    setBellStatus("Bell Activated");
    setLastBell(
      new Date().toLocaleTimeString()
    );

    bellTriggeredRef.current = true;

    const ticketDoc = tickets.find(
      (item) => item.ticketId === ticket
    );

    if (ticketDoc) {
      try {
        await updateDoc(
          doc(db, "tickets", ticketDoc.id),
          {
            status: "completed",
            bellTriggeredAt: serverTimestamp(),
            bellTriggerLocation: currentLocation,
          }
        );
      } catch (error) {
        console.error(
          "Ticket status update error:",
          error
        );
      }
    }
  };

  useEffect(() => {
    if (
      destination &&
      distanceToDestination !== null &&
      distanceToDestination <= GEOFENCE_KM &&
      !bellTriggeredRef.current
    ) {
      void triggerBell();
    } else if (
      destination &&
      distanceToDestination !== null &&
      distanceToDestination > GEOFENCE_KM
    ) {
      setBellStatus("Monitoring");
    }
  }, [destination, distanceToDestination]);

  useEffect(() => {
    if (
      !simulationRunning ||
      gpsMode !== "simulator"
    ) {
      return;
    }

    const simulationPath = routeStops.map(stopName => {
      const stop = stops.find(s => s.name === stopName);
      return { lat: stop!.lat, lng: stop!.lng, name: stopName };
    });

    if (
      simulationStep >=
      simulationPath.length - 1
    ) {
      setSimulationRunning(false);
      return;
    }

    const timer = window.setTimeout(() => {
      const nextStep = simulationStep + 1;
      setSimulationStep(nextStep);

      setCurrentLocation({
        lat: simulationPath[nextStep].lat,
        lng: simulationPath[nextStep].lng
      });
      
      if (simulationPath[nextStep].name === destination) {
        setSimulationRunning(false);
      }
    }, 1200);

    return () =>
      window.clearTimeout(timer);
  }, [
    simulationRunning,
    simulationStep,
    gpsMode,
    routeStops,
    destination
  ]);

  useEffect(() => {
    if (!bus || !currentLocation || !route) return;

    const now = Date.now();
    // Throttle GPS writes to every 3 seconds to save database costs
    if (now - lastSyncRef.current < 3000) return;

    lastSyncRef.current = now;

    const syncLocation = async () => {
      try {
        await setDoc(
          doc(db, "buses", bus),
          {
            currentLocation,
            route,
            lastUpdated: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (error) {
        console.error("GPS sync error:", error);
      }
    };

    void syncLocation();
  }, [bus, currentLocation, route]);

  const startSimulation = () => {
    if (!destination) {
      alert(
        "Select a destination before starting GPS simulation."
      );
      return;
    }

    bellTriggeredRef.current = false;

    setBellStatus("Monitoring");
    setLastBell("");

    setSimulationStep(0);

    const firstStopName = routeStops[0];
    const firstStop = stops.find(s => s.name === firstStopName);

    if (firstStop) {
      setCurrentLocation({
        lat: firstStop.lat,
        lng: firstStop.lng,
      });
    } else {
      setCurrentLocation({
        lat: 16.7047,
        lng: 74.2438,
      });
    }

    setGpsMode("simulator");
    setSimulationRunning(true);
  };

  const stopSimulation = () => {
    setSimulationRunning(false);
  };

  const useRealGPS = () => {
    if (!navigator.geolocation) {
      setGpsError(
        "Geolocation is not supported."
      );
      return;
    }

    setGpsError("");
    setGpsMode("real");

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCurrentLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      () => {
        setGpsError(
          "Unable to access real GPS. Allow location permission."
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000,
      }
    );
  };

  const resetDemo = () => {
    setSimulationRunning(false);
    setSimulationStep(0);

    const firstStopName = routeStops[0];
    const firstStop = stops.find(s => s.name === firstStopName);

    if (firstStop) {
      setCurrentLocation({
        lat: firstStop.lat,
        lng: firstStop.lng,
      });
    } else {
      setCurrentLocation({
        lat: 16.7047,
        lng: 74.2438,
      });
    }

    setBellStatus("Monitoring");
    setLastBell("");

    bellTriggeredRef.current = false;
  };

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="mx-auto max-w-[1500px] px-4 py-5 sm:px-6 lg:px-8">

        {/* HEADER */}

        <header className="mb-6 flex flex-col gap-4 border-b border-slate-800 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-xl text-slate-950 shadow-lg">
                🔔
              </div>

              <div>
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  Ticket2Bell
                </h1>

                <p className="text-sm text-slate-400">
                  Conductor Digital Bell System
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-emerald-800 bg-emerald-950/40 px-4 py-2">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400" />

              <span className="text-sm font-medium text-emerald-300">
                System Online
              </span>
            </div>

            <div className="hidden rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-slate-400 sm:block">
              Firebase Connected
            </div>
          </div>
        </header>

        {/* CORE FLOW */}

        <section className="mb-6 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">

          <div className="border-b border-slate-800 px-5 py-5 sm:px-6">
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
              Intelligent Bell Workflow
            </p>

            <h2 className="text-xl font-bold sm:text-2xl">
              Ticket Destination → Live GPS → Automatic Bell
            </h2>

            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              The system connects every passenger destination
              with the bus&apos;s live location and automatically
              triggers the bell when the destination geofence
              is reached.
            </p>
          </div>

          <div className="grid grid-cols-2 divide-x divide-y divide-slate-800 md:grid-cols-5 md:divide-y-0">

            <div className="p-4 sm:p-5">
              <p className="text-xs text-slate-500">
                01
              </p>
              <p className="mt-2 text-lg">🎫</p>
              <p className="mt-2 text-sm font-semibold">
                Ticket
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Destination captured
              </p>
            </div>

            <div className="p-4 sm:p-5">
              <p className="text-xs text-slate-500">
                02
              </p>
              <p className="mt-2 text-lg">🚌</p>
              <p className="mt-2 text-sm font-semibold">
                Live Bus
              </p>
              <p className="mt-1 text-xs text-slate-500">
                GPS location
              </p>
            </div>

            <div className="p-4 sm:p-5">
              <p className="text-xs text-slate-500">
                03
              </p>
              <p className="mt-2 text-lg">📍</p>
              <p className="mt-2 text-sm font-semibold">
                Stop Match
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Destination detected
              </p>
            </div>

            <div className="p-4 sm:p-5">
              <p className="text-xs text-slate-500">
                04
              </p>
              <p className="mt-2 text-lg">🎯</p>
              <p className="mt-2 text-sm font-semibold">
                Geofence
              </p>
              <p className="mt-1 text-xs text-slate-500">
                30m decision zone
              </p>
            </div>

            <div className="col-span-2 p-4 sm:p-5 md:col-span-1">
              <p className="text-xs text-slate-500">
                05
              </p>
              <p className="mt-2 text-lg">🔔</p>
              <p className="mt-2 text-sm font-semibold">
                Bell Trigger
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Automatic action
              </p>
            </div>

          </div>
        </section>

        {/* KPI CARDS */}

        <section className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Live Bus
            </p>

            <div className="mt-3 flex items-center justify-between">
              <div>
                <p className="text-xl font-bold">
                  {bus || "Not Selected"}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  {gpsMode === "simulator"
                    ? "GPS Simulator"
                    : "Real GPS"}
                </p>
              </div>

              <span className="text-2xl">
                🚌
              </span>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Current Stop
            </p>

            <div className="mt-3 flex items-center justify-between">
              <div>
                <p className="text-xl font-bold">
                  {nearestStop.stop.name}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  Nearest detected location
                </p>
              </div>

              <span className="text-2xl">
                📍
              </span>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Passenger Target
            </p>

            <div className="mt-3 flex items-center justify-between">
              <div>
                <p className="text-xl font-bold">
                  {destination || "Waiting"}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  {distanceToDestination !== null
                    ? `${distanceToDestination.toFixed(2)} km away`
                    : "No active target"}
                </p>
              </div>

              <span className="text-2xl">
                🎯
              </span>
            </div>
          </div>

          <div
            className={`rounded-2xl border p-5 ${
              bellStatus === "Bell Activated"
                ? "border-emerald-700 bg-emerald-950/40"
                : "border-slate-800 bg-slate-900"
            }`}
          >
            <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
              Bell Engine
            </p>

            <div className="mt-3 flex items-center justify-between">
              <div>
                <p className="text-xl font-bold">
                  {bellStatus === "Bell Activated"
                    ? "ACTIVATED"
                    : "MONITORING"}
                </p>

                <p className="mt-1 text-xs text-slate-500">
                  {destinationReached
                    ? "Destination reached"
                    : "Waiting for geofence"}
                </p>
              </div>

              <span className="text-2xl">
                {bellStatus === "Bell Activated"
                  ? "🔔"
                  : "🟢"}
              </span>
            </div>
          </div>
        </section>

        {/* MAIN GRID */}

        <div className="grid gap-6 xl:grid-cols-3">

          {/* TICKET CREATION */}

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl xl:col-span-1">

            <div className="mb-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Conductor Action
              </p>

              <h2 className="mt-1 text-xl font-bold">
                Generate Passenger Ticket
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                Capture the destination that should
                trigger the bell.
              </p>
            </div>

            <div className="space-y-4">

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Bus
                </label>

                <select
                  value={bus}
                  onChange={(e) => {
                    setBus(e.target.value);
                    setValidationError("");
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none transition focus:border-white"
                >
                  <option value="">
                    Select Bus
                  </option>

                  {buses.map((item) => (
                    <option
                      key={item}
                      value={item}
                    >
                      {item}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Route
                </label>

                <select
                  value={route}
                  onChange={(e) => {
                    setRoute(e.target.value);
                    setDestination("");
                    setValidationError("");
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-white"
                >
                  {Object.keys(routes).map(
                    (item) => (
                      <option
                        key={item}
                        value={item}
                      >
                        {item}
                      </option>
                    )
                  )}
                </select>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Passenger Destination
                </label>

                <select
                  value={destination}
                  onChange={(e) => {
                    setDestination(
                      e.target.value
                    );

                    setBellStatus(
                      "Monitoring"
                    );

                    bellTriggeredRef.current =
                      false;

                    setValidationError("");
                  }}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none focus:border-white"
                >
                  <option value="">
                    Select Destination
                  </option>

                  {availableDestinations.map(
                    (stop) => (
                      <option
                        key={stop.name}
                        value={stop.name}
                      >
                        {stop.name}
                      </option>
                    )
                  )}
                </select>
              </div>

              <button
                onClick={generateTicket}
                disabled={saving}
                className="w-full rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving
                  ? "Saving Ticket..."
                  : "Generate Ticket →"}
              </button>

              {validationError && (
                <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-400">
                  {validationError}
                </div>
              )}
            </div>

            {ticket && generatedTicket && (
              <div className="mt-5 relative overflow-hidden rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
                <div className="absolute left-0 top-0 h-full w-2 bg-emerald-500" />
                
                <div className="mb-4 flex items-center justify-between border-b border-dashed border-slate-700 pb-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
                    Digital Bus Ticket
                  </span>
                  <span className="rounded-full bg-emerald-950 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                    {generatedTicket.status}
                  </span>
                </div>

                <div className="mb-4 flex items-end justify-between">
                  <div>
                    <p className="font-mono text-3xl font-bold tracking-tight text-white">
                      {generatedTicket.ticketId}
                    </p>
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      Generated: {generatedTicket.createdAt.toLocaleTimeString()}
                    </p>
                  </div>
                  <div className="text-4xl opacity-20">🎫</div>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Bus Number
                    </p>
                    <p className="font-semibold text-slate-200">
                      {generatedTicket.bus}
                    </p>
                  </div>

                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Route
                    </p>
                    <p className="truncate font-semibold text-slate-200">
                      {generatedTicket.route}
                    </p>
                  </div>

                  <div className="col-span-2 rounded-lg border border-slate-800 bg-slate-950 p-3">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Passenger Destination
                    </p>
                    <p className="text-lg font-bold text-emerald-400">
                      {generatedTicket.destination}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* LIVE BUS */}

          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl xl:col-span-2">

            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">

              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Live Tracking
                </p>

                <h2 className="mt-1 text-xl font-bold">
                  Bus GPS & Route Monitor
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  Monitor the bus position against the passenger destination.
                </p>
              </div>

              <span className="w-fit rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-400">
                {gpsMode === "simulator"
                  ? "● Simulator"
                  : "● Real GPS"}
              </span>
            </div>

            {/* ROUTE */}

            <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950 p-5">

              <div className="mb-6 flex items-center justify-between">
                <div>
                  <p className="text-xs text-slate-500">
                    CURRENT ROUTE
                  </p>

                  <p className="mt-1 font-semibold">
                    {route}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-xs text-slate-500">
                    BUS
                  </p>

                  <p className="mt-1 font-semibold">
                    {bus || "--"}
                  </p>
                </div>
              </div>

              <div className="relative">

                <div className="absolute left-5 right-5 top-5 h-1 rounded-full bg-slate-800" />

                <div className="relative grid grid-cols-4 gap-2">

                  {routeStops.map(
                    (stopName, index) => {
                      const stopIndex = routeStops.indexOf(stopName);

                      const passed =
                        simulationStep >=
                        stopIndex;

                      const isTarget =
                        destination ===
                        stopName;

                      return (
                        <div
                          key={stopName}
                          className="relative z-10 flex flex-col items-center text-center"
                        >
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-full border-4 border-slate-950 text-sm ${
                              isTarget
                                ? "bg-white text-slate-950"
                                : passed
                                ? "bg-emerald-500 text-white"
                                : "bg-slate-700 text-slate-400"
                            }`}
                          >
                            {isTarget
                              ? "🎯"
                              : passed
                              ? "✓"
                              : "•"}
                          </div>

                          <p className="mt-3 text-[10px] font-semibold text-slate-300 sm:text-xs">
                            {stopName}
                          </p>
                        </div>
                      );
                    }
                  )}

                </div>

                <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900 p-4">

                  <div className="flex flex-wrap items-center justify-between gap-3">

                    <div>
                      <p className="text-xs text-slate-500">
                        CURRENT GPS
                      </p>

                      <p className="mt-1 font-mono text-sm">
                        {currentLocation.lat.toFixed(
                          5
                        )}
                        ,{" "}
                        {currentLocation.lng.toFixed(
                          5
                        )}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-slate-500">
                        NEAREST STOP
                      </p>

                      <p className="mt-1 font-semibold">
                        {nearestStop.stop.name}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-slate-500">
                        TARGET DISTANCE
                      </p>

                      <p className="mt-1 font-bold">
                        {distanceToDestination !==
                        null
                          ? `${distanceToDestination.toFixed(
                              2
                            )} km`
                          : "--"}
                      </p>
                    </div>

                  </div>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">

                <button
                  onClick={startSimulation}
                  className="rounded-xl bg-white px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-slate-200"
                >
                  ▶ Start GPS
                </button>

                <button
                  onClick={stopSimulation}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  ■ Stop
                </button>

                <button
                  onClick={useRealGPS}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  📍 Real GPS
                </button>

                <button
                  onClick={resetDemo}
                  className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  ↻ Reset
                </button>

              </div>

              {gpsError && (
                <div className="mt-3 rounded-xl border border-red-900 bg-red-950/40 p-3 text-sm text-red-400">
                  {gpsError}
                </div>
              )}

            </div>
          </section>
        </div>

        {/* ACTIVE TICKETS */}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl">

          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Firestore Live Data
              </p>

              <h2 className="mt-1 text-xl font-bold">
                Active Passenger Tickets
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                Real-time tickets being monitored by the system.
              </p>
            </div>

            <div className="rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-sm">
              <span className="font-bold">
                {activeTickets.length}
              </span>{" "}
              <span className="text-slate-500">
                active
              </span>
            </div>

          </div>

          <div className="mt-5 overflow-x-auto">

            <table className="w-full min-w-[700px] text-left text-sm">

              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-3">
                    Ticket
                  </th>

                  <th className="px-3 py-3">
                    Bus
                  </th>

                  <th className="px-3 py-3">
                    Route
                  </th>

                  <th className="px-3 py-3">
                    Destination
                  </th>

                  <th className="px-3 py-3">
                    Status
                  </th>
                </tr>
              </thead>

              <tbody>
                {activeTickets
                  .slice(0, 10)
                  .map((item) => (
                    <tr
                      key={item.id}
                      className="border-b border-slate-800 transition hover:bg-slate-950"
                    >
                      <td className="px-3 py-4 font-mono font-semibold">
                        {item.ticketId ||
                          item.id}
                      </td>

                      <td className="px-3 py-4">
                        {item.bus || "--"}
                      </td>

                      <td className="px-3 py-4 text-slate-400">
                        {item.route || "--"}
                      </td>

                      <td className="px-3 py-4 font-semibold">
                        {item.destination ||
                          "--"}
                      </td>

                      <td className="px-3 py-4">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            item.status ===
                            "completed"
                              ? "bg-emerald-950 text-emerald-400"
                              : "bg-blue-950 text-blue-400"
                          }`}
                        >
                          {item.status ||
                            "monitoring"}
                        </span>
                      </td>
                    </tr>
                  ))}

                {activeTickets.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-12 text-center"
                    >
                      <div className="text-3xl">
                        🎫
                      </div>

                      <p className="mt-3 font-semibold">
                        No active tickets
                      </p>

                      <p className="mt-1 text-sm text-slate-500">
                        Generate a ticket to start destination monitoring.
                      </p>
                    </td>
                  </tr>
                )}

              </tbody>
            </table>
          </div>
        </section>

        {/* BELL ENGINE */}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl">

          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Decision Layer
              </p>

              <h2 className="mt-1 text-xl font-bold">
                Automatic Bell Decision Engine
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                The system evaluates destination, GPS position and geofence distance.
              </p>
            </div>

            <div
              className={`rounded-xl border px-5 py-3 ${
                destinationReached
                  ? "border-emerald-700 bg-emerald-950/40"
                  : "border-slate-700 bg-slate-950"
              }`}
            >
              <p className="text-xs text-slate-500">
                ENGINE DECISION
              </p>

              <p className="mt-1 font-bold">
                {destinationReached
                  ? "DESTINATION REACHED"
                  : "MONITORING"}
              </p>
            </div>

          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-4">

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  GPS Signal
                </p>

                <span className="text-emerald-400">
                  ✓
                </span>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Live location available
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  Destination
                </p>

                <span
                  className={
                    destination
                      ? "text-emerald-400"
                      : "text-slate-600"
                  }
                >
                  {destination ? "✓" : "—"}
                </span>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                {destination || "Waiting for ticket"}
              </p>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  Geofence
                </p>

                <span
                  className={
                    destinationReached
                      ? "text-emerald-400"
                      : "text-amber-400"
                  }
                >
                  {destinationReached
                    ? "✓"
                    : "●"}
                </span>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Radius: {GEOFENCE_KM * 1000}m
              </p>
            </div>

            <div
              className={`rounded-xl border p-4 ${
                bellStatus ===
                "Bell Activated"
                  ? "border-emerald-700 bg-emerald-950/40"
                  : "border-slate-800 bg-slate-950"
              }`}
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">
                  Bell Action
                </p>

                <span className="text-xl">
                  {bellStatus ===
                  "Bell Activated"
                    ? "🔔"
                    : "🔕"}
                </span>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                {bellStatus ===
                "Bell Activated"
                  ? "Automatically triggered"
                  : "Waiting for destination"}
              </p>
            </div>

          </div>

          <div className="mt-5 flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-950 p-4 sm:flex-row sm:items-center sm:justify-between">

            <div>
              <p className="text-xs text-slate-500">
                CURRENT BELL STATUS
              </p>

              <p
                className={`mt-1 text-lg font-bold ${
                  bellStatus ===
                  "Bell Activated"
                    ? "text-emerald-400"
                    : "text-white"
                }`}
              >
                {bellStatus ===
                "Bell Activated"
                  ? "🔔 DIGITAL BELL ACTIVATED"
                  : "🟢 MONITORING DESTINATION"}
              </p>

              {lastBell && (
                <p className="mt-1 text-xs text-slate-500">
                  Last trigger: {lastBell}
                </p>
              )}
            </div>

            <button
              onClick={() =>
                void triggerBell()
              }
              disabled={!ticket}
              className="rounded-xl border border-slate-600 bg-white px-5 py-3 text-sm font-bold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-30"
            >
              🔔 Manual Bell Override
            </button>

          </div>
        </section>

        {/* COMPLETED BELL EVENTS */}

        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl">

          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Historical Data
              </p>

              <h2 className="mt-1 text-xl font-bold">
                Completed Bell Events
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                History of automated bell triggers and their locations.
              </p>
            </div>

            <div className="rounded-full border border-slate-700 bg-slate-950 px-4 py-2 text-sm">
              <span className="font-bold">
                {completedTickets.length}
              </span>{" "}
              <span className="text-slate-500">
                completed
              </span>
            </div>

          </div>

          <div className="mt-5 overflow-x-auto">

            <table className="w-full min-w-[800px] text-left text-sm">

              <thead>
                <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-3">
                    Ticket
                  </th>

                  <th className="px-3 py-3">
                    Bus
                  </th>

                  <th className="px-3 py-3">
                    Destination
                  </th>

                  <th className="px-3 py-3">
                    Trigger Time
                  </th>

                  <th className="px-3 py-3">
                    Trigger Location
                  </th>

                  <th className="px-3 py-3">
                    Status
                  </th>
                </tr>
              </thead>

              <tbody>
                {completedTickets
                  .slice(0, 10)
                  .map((item) => {
                    let triggerTime = "--";
                    if (item.bellTriggeredAt) {
                      const dt = item.bellTriggeredAt as any;
                      if (dt.toDate) {
                        triggerTime = dt.toDate().toLocaleTimeString();
                      } else if (dt.seconds) {
                        triggerTime = new Date(dt.seconds * 1000).toLocaleTimeString();
                      }
                    }

                    return (
                      <tr
                        key={item.id}
                        className="border-b border-slate-800 transition hover:bg-slate-950"
                      >
                        <td className="px-3 py-4 font-mono font-semibold">
                          {item.ticketId || item.id}
                        </td>

                        <td className="px-3 py-4">
                          {item.bus || "--"}
                        </td>

                        <td className="px-3 py-4 font-semibold">
                          {item.destination || "--"}
                        </td>

                        <td className="px-3 py-4 text-slate-400">
                          {triggerTime}
                        </td>

                        <td className="px-3 py-4 text-slate-400 font-mono text-xs">
                          {item.bellTriggerLocation
                            ? `${item.bellTriggerLocation.lat.toFixed(5)}, ${item.bellTriggerLocation.lng.toFixed(5)}`
                            : "--"}
                        </td>

                        <td className="px-3 py-4">
                          <span className="rounded-full bg-emerald-950 px-3 py-1 text-xs font-semibold text-emerald-400">
                            completed
                          </span>
                        </td>
                      </tr>
                    );
                  })}

                {completedTickets.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-12 text-center"
                    >
                      <div className="text-3xl">
                        🔕
                      </div>

                      <p className="mt-3 font-semibold">
                        No completed events
                      </p>

                      <p className="mt-1 text-sm text-slate-500">
                        Completed bell triggers will appear here.
                      </p>
                    </td>
                  </tr>
                )}

              </tbody>
            </table>
          </div>
        </section>

        {/* FOOTER */}

        <footer className="py-8 text-center">

          <p className="text-sm font-semibold text-slate-400">
            Ticket2Bell
          </p>

          <p className="mt-1 text-xs text-slate-600">
            GPS-based destination detection • Geofencing • Automatic digital bell
          </p>

        </footer>

      </div>
    </main>
  );
}