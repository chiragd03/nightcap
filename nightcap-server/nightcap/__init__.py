"""The Nightcap server: Home, title pages, search and playback for the Nightcap TV launcher.

Watch history lives in Postgres (store.py). Candidates come from TMDB and the AI picks and
ranks them; streams and subtitles come from the account's add-ons. api.py is the way in.
"""
