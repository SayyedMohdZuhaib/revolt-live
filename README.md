Voice Chat App
This is a simple web app with one mic button that connects to the backend, starts recording your voice, sends it to the server, and plays back the server’s response.

Features
One button control – click to start, click again to stop.

Automatic connect, record, stop, and disconnect.

Mic icon changes when recording.

Works with light & dark themes.

How to Use
Open the webpage in your browser.

Click the mic button to start talking.

Click the mic button again to stop.

The backend will handle speech recognition and reply.

How It Works
When you click the mic button:

It connects to the backend WebSocket.

Starts streaming your microphone audio in PCM format.

When you click again:

It stops the mic and closes the connection.

Requirements
A backend server that supports WebSocket audio streaming.

Browser with microphone permission enabled.

Running
Put index.html and client.js in your web project folder.

Open index.html in your browser.

Make sure your backend WebSocket URL is set in client.js.

