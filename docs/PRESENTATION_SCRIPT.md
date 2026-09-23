# AI Push-Up Coach — presentation script

Use this as speaking notes. The main talk takes about three minutes, followed by a short live demo. Practice once with the actual camera and room lighting.

## Model choice

For the presentation, use the model **currently shipped in the browser**: the MediaPipe Pose Landmarker Full for body tracking and a **300-tree Random Forest** for good/bad form classification. The forest uses 34 movement features and a 0.58 decision threshold. A newer candidate was tested, but it performed worse on the held-out people, so we did not replace the shipped model. The reported **74.6% accuracy is for form classification on 205 labeled reps from four unseen people**. It is not a measurement of rep-counting accuracy or phone-camera accuracy.

## Main script — say this

**Opening — about 25 seconds**

“Hi, this is AI Push-Up Coach. The problem we wanted to solve is simple: when someone exercises alone, they can count push-ups, but it is hard to know whether each rep has good form. A normal video recording only shows the movement afterward. Our app gives live rep counting and form feedback while you train.”

**What we built — about 35 seconds**

“The app runs in a web browser on a laptop or phone. You allow camera access, position your body in the frame, and complete a short camera check. Then you can start counting. The workout screen shows your reps, time, body tracking, and feedback. There is also a 30-second challenge and a game controlled by body movement.”

**How it works — about 60 seconds**

“Here is the pipeline. First, the browser reads camera frames. MediaPipe Pose estimates 33 body landmarks, including shoulders, elbows, hips, and ankles. We smooth and check those landmarks, then calculate joint angles and body alignment. Rep counting uses an explainable state machine: it looks for a controlled down movement followed by an up movement, with thresholds adapted during calibration. When a rep finishes, we turn its motion into 34 numerical features, such as elbow angle, range of motion, timing, and body line. A Random Forest model trained with Python and scikit-learn predicts whether that rep has good form. We export that model to JSON so the browser can run it locally. The app combines that prediction with geometry-based checks to give a useful explanation.”

**Technology and privacy — about 35 seconds**

“We built the interface with Next.js, React, TypeScript, and Tailwind CSS. The vision layer uses MediaPipe. Python and scikit-learn were used to prepare the data, train the classifier, and evaluate it. There is an optional FastAPI service for evaluation and data endpoints, but live camera tracking and scoring run in the browser. Camera video is not uploaded. Session numbers are saved in the browser, with optional Supabase syncing if configured.”

**Results and honest close — about 35 seconds**

“We evaluated form classification on people who were not in the training group. On 205 labeled reps from four unseen people, the shipped model achieved 74.6% accuracy and 75.6% recall for bad-form reps. Those numbers show that the system is promising, but it can still make mistakes. Lighting, camera angle, body visibility, and phone placement affect tracking. Our next step is to collect more labeled phone-camera sessions and evaluate both counting and form feedback across more people. Thank you — I’ll show a short demo.”

## Live demo — 45 to 90 seconds

1. Open **Workout**. Say: “The camera and pose estimation run on this device.” Allow camera permission.
2. Put your whole body in frame. Choose the matching front or side view if needed. Say: “The camera check tells me what to adjust before scoring.”
3. Make a few slow calibration movements. Use the **Start counting** control when it is available; there may be a three-second countdown.
4. Do two or three controlled reps. Point to the rep count and feedback only after they actually update. End the session and show the summary.
5. If time allows, show **30s Challenge** or **Flappy Push-Up**. Describe these as separate modes built around the same body tracking, not as evidence that the form model is more accurate.

If the camera fails at the venue, show the workout screen, explain the pipeline above, and show a previously saved session **only if you actually have one**. Do not present sample artwork or a static preview as a live prediction.

## Questions judges may ask

**1. Is the rep counter an AI model?**

No. MediaPipe estimates body landmarks, then a calibrated angle and motion state machine detects the down-and-up cycle. The trained classifier judges form after a rep is detected.

**2. Why use two models?**

MediaPipe solves pose estimation: finding body points in each frame. The Random Forest solves a different task: classifying the motion of a completed rep from measured features.

**3. Why Random Forest instead of a neural network?**

Our dataset is modest, and the input is a small table of movement measurements. The forest is fast in the browser and was the strongest *shipped* candidate on the unseen-person test. We tested another forest configuration, but it scored worse there, so we kept the current model.

**4. How did you avoid testing on the same people used for training?**

The training pipeline groups data by person. Development uses 20 people; the final reported test contains 205 reps from four other people. That is more realistic than randomly mixing one person's reps across train and test.

**5. What does 74.6% mean?**

It means about 74.6% of the 205 labeled test reps received the correct good/bad **form label**. It does not mean 74.6% rep-counting accuracy. We have not measured a reliable live-phone accuracy figure yet.

**6. How does it know what was wrong with a rep?**

It uses measured geometry, such as elbow depth and body alignment, to produce feedback alongside the classifier's good/bad probability. These explanations come from the measured features and rules; the forest itself is not a language model.

**7. What happens if the camera cannot see the elbow or body?**

Tracking quality and camera alignment checks ask the user to adjust position or lighting. Weak or missing landmarks can make scoring unreliable, so the app should not claim certainty in that situation.

**8. Does my video go to a server?**

No camera frames are uploaded for live coaching. The pose and form pipeline runs in the browser. Numeric workout summaries can be synced to Supabase only when that optional integration is configured.

**9. What is the backend for?**

The optional FastAPI service provides model and data endpoints for evaluation or persistence. A normal live workout uses the browser inference path, so it does not need a server round trip to score each rep.

**10. What are the biggest limitations and next improvements?**

The test set has only four unseen people. Different phones, camera angles, lighting, and exercise styles need broader evaluation. The next responsible improvement is a newly labeled, person-separated phone-camera test set, then model changes measured against it.

## Before you present

- Open the app in the browser you will use on stage and confirm camera permission.
- Test the exact camera angle, distance, and lighting in the presentation room.
- Do a complete calibration and two counted reps, then end the session.
- Keep the model result precise: **74.6% form-label accuracy on 205 reps from four unseen people**.
- If asked about “the best model,” say: “We kept the best verified model for this shipped demo; a candidate that looked better during development performed worse on the held-out people.”
