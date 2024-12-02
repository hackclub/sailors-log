# Sailor's Log

A cute Slack & Discord bot to celebrate you whenever you reach an hour coding in High Seas.

It will also optionally post a weekly leaderboard in your channel (this is TODO, you can currently run `/sailorslog leaderboard` to see it).

## User Flow

Slack:

1. `/sailorslog on` in any channel to opt in
2. TODO `/sailorslog leaderboard on` to enable the leaderboard for all opted in users in the channel
3. `/sailorslog leaderboard` to see the current leaderboard for the channel they're in (message visible only to them)

Sample message: “@zrl just reached 2 hours coding on etl-scripts (LINKED if repo exists) in High Seas (LINKED). Nice work!”

Sample leaderboard:

```
Today's leaderboard:

1. zrl - 2 hours (projectName (LINKED if repo exists) & projectName in Java, C#, and Bash)
2. zrl - 1 hour
3. zrl - 1 hour
```

## Architecture

Poll for new heartbeats

When new heartbeats come in, see which users had heartbeats

Make an API request to see their current hours toward projects

Save the API response in the DB so we can calculate the leaderboard later

If they've reached an hour, post a message to Slack
