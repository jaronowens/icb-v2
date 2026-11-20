Currently, this project is written primarily in Typescript, but is manually compiled and runs as Javascript (see "Use of both Typescript and Javascript" section of the readme).

Add a command to this project, `npm build`, to be executed on the command line.

The `build` command should compile all Typescript files into Javascript files and place the compiled JS files in a directory called `/build` with the same directory structure as the root project. If compiled JS files already exist in these directories, they should be recompiled.

When the server is started with `npm start`, the compiled JS should be used as the source.