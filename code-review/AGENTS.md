# Code Review Tool

We'll be creating a rust based code review tool. The goal will be to serve the tool over the by compiling our code to be web assembly based (at least on the frontend). Our gui code will be built using the egui crate. The end purpose of the tool will be something like have an easily launchable binary that when launched in a folder will give me a GUI to review code with a very specific flow I want. We'll progressively build out the features together starting simple and then adding features as we go.

## Development rules
- When managing crates, stick to the newest versions whenever possible and manage crates using cargo instead of file edits
- Use the rust-analyzer to quickly validate changes
- Use clippy before returning and ensure the code passes all clippy lints
- Keep things rusty in the code. Use safe code only. Use chained iterator lines over looping. Use traits where needed to make syntax cleaner etc...
- We want code thats not just functional but beautiful, concise, and self documenting
- Use tokio for I/O bound tasks, and rayon for compute bound tasks
- Keep things configurable. Use rust canonical configuration patterns to avoid hardcoding things that we might want to change 

## eGUI tips
- eGUI is an immeadiate mode GUI system, this means we should keep work off the main thread whereever possible and we have a tight budget of what we can do between frames. Respect this
- If things aren't visible, don't bother doing work on them in the eGUI loop
- For async tasks we can use redraw request to avoid excessive polling of tasks with loops especially when users aren't interacting
- While we can't style things with full CSS control, egui can make very beautiful applications
- Design things to be professional and easy on the eyes. I really like the styling of distill.pub, and so be inspired by that
- Make a document called `egui_notes.md` for helpful notes about the crate that you learn along the way to avoid needing to lookup a lot repeatedly as we develop, but keep it to the most important ones.

