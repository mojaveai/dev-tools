# Background progress

When going dormant and setting up a background progress or agent, always setup a time based heartbeat that should act as a circuit breaker for you to check in on the agent or process. Set it to the expected upper bound of how long you expect it to take so you can check on it efficiently. Never go more 30 minutes without checking in on a process or task.
