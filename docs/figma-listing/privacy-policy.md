# Figbridge — Privacy Policy

_Last updated: 2026-04-22_

## Short version

Figbridge does not collect, store, or transmit your data to anyone. Everything happens on your machine.

## What the plugin sees

The plugin reads the Figma file you have open, the same way any Figma plugin does. It uses that data to produce exports, specs, lint reports, and edits — all of which are returned either to the plugin UI or to the local bridge described below.

## Where data goes

The plugin makes exactly one network connection: to `http://localhost:7331` on your own machine. That address is the Figbridge bridge process (`figbridge-mcp`), an open-source Node program you install yourself. No other domains are contacted.

If you do not run the bridge, the plugin makes no network connections at all.

## What the bridge does with data

The bridge forwards plugin responses to whichever MCP-speaking client you have connected locally (for example Claude Desktop, Claude Code, Cursor, or Continue). These clients may, in turn, send the data to whichever AI model you have configured them to use — under **your** account and **your** privacy agreement with that provider.

Figbridge itself has no access to those providers. Figbridge never sends your data anywhere other than to the bridge you started on your own machine.

## Telemetry

There is none.

## Accounts

There are none.

## Cookies, analytics, third-party scripts

There are none.

## Source

Both the plugin and the bridge are MIT-licensed open source. You can audit the full network surface at https://github.com/rudra-rps/figbridge.

## Contact

- Author: Rudra Pratap Singh
- Email: rudra.ptp.singh@gmail.com
